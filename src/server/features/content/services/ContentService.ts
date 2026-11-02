import { sort } from "remeda";
import { ContentRepository } from "@/server/features/content/repositories/ContentRepository";
import { preparedRevisionWriteSchema } from "@/server/features/content/repositories/contentRevisionWrites";
import { AppError } from "@/server/lib/errors";
import { sha256Hex } from "@/server/lib/audit/ids";
import {
  createContentBriefInputSchema,
  saveContentRevisionInputSchema,
  archiveContentInputSchema,
  listContentRevisionsInputSchema,
  listContentInputSchema,
  type ContentActor,
  type CreateContentBriefInput,
  type SaveContentRevisionInput,
  type ArchiveContentInput,
  type ListContentRevisionsInput,
  type ListContentInput,
} from "@/types/schemas/content";
import { contentAccess } from "./contentAccess";
import { contentContextSnapshot } from "./contentContextSnapshot";
import { validateContentClaims } from "./contentClaims";
import { createContentCheckSet } from "./contentChecks";
import { ContentSourceService } from "./ContentSourceService";
import { getRevision, getRevisionStatus } from "./contentRevisionRead";

async function replay(
  actor: ContentActor,
  projectId: string,
  mutationId: string,
  kind: "create" | "save",
  hash: string,
) {
  const receipt = await ContentRepository.getMutation(
    actor.organizationId,
    projectId,
    mutationId,
  );
  if (!receipt) return null;
  if (receipt.kind !== kind || receipt.requestHash !== hash)
    throw new AppError("CONFLICT", "mutation_id_conflict");
  const revision = await ContentRepository.getRevisionById(
    actor.organizationId,
    projectId,
    receipt.resultId,
  );
  await contentAccess(actor, projectId);
  if (!revision) throw new AppError("CONFLICT", "revision_unavailable");
  return { ok: true as const, revision, headVersion: revision.version };
}

async function save(
  actor: ContentActor,
  input: SaveContentRevisionInput,
  creating: boolean,
) {
  const access = await contentAccess(actor, input.projectId);
  const kind = creating ? "create" : "save";
  const requestHash = await sha256Hex(
    JSON.stringify(
      creating
        ? {
            projectId: input.projectId,
            mutationId: input.mutationId,
            expectedHeadVersion: 0,
            brief: input.brief,
          }
        : input,
    ),
  );
  const previous = await replay(
    actor,
    input.projectId,
    input.mutationId,
    kind,
    requestHash,
  );
  if (previous) return previous;
  const current = creating
    ? null
    : await ContentRepository.getRevision(
        actor.organizationId,
        input.projectId,
        input.contentId,
      );
  if (!creating && !current) throw new AppError("NOT_FOUND");
  if (!creating && current && current.version !== input.expectedHeadVersion) {
    const racedReplay = await replay(
      actor,
      input.projectId,
      input.mutationId,
      kind,
      requestHash,
    );
    if (racedReplay) return racedReplay;
    return {
      ok: false as const,
      code: "revision_conflict" as const,
      currentHeadVersion: current.version,
    };
  }
  const live = await contentContextSnapshot(
    actor.organizationId,
    input.projectId,
    input.brief.locale,
  );
  if (!creating && live.contextVersion !== input.expectedContextVersion) {
    const racedReplay = await replay(
      actor,
      input.projectId,
      input.mutationId,
      kind,
      requestHash,
    );
    if (racedReplay) return racedReplay;
    throw new AppError("CONFLICT", "context_changed");
  }
  const sourceIds = sort([...new Set(input.sourceIds)], (a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (sourceIds.length !== input.sourceIds.length)
    throw new AppError("VALIDATION_ERROR", "duplicate_source");
  const sources = await Promise.all(
    sourceIds.map((id) => ContentSourceService.get(actor, input.projectId, id)),
  );
  const text = new Map(sources.map((source) => [source.id, source.sourceText]));
  const validated = await validateContentClaims(
    input.markdown,
    input.metadata,
    input.claims,
    text,
  );
  const auditSourceIds = new Set(
    sources
      .filter((source) => source.kind === "audit")
      .map((source) => source.id),
  );
  if (
    validated.some(
      (claim) =>
        ["product", "security", "financial", "legal"].includes(claim.kind) &&
        claim.evidence.some(
          (entry) =>
            entry.relation === "supports" && auditSourceIds.has(entry.sourceId),
        ),
    )
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "audit_observation_not_sensitive_claim_support",
    );
  if (
    validated.some((claim) =>
      claim.evidence.some((entry) => !sourceIds.includes(entry.sourceId)),
    )
  )
    throw new AppError("VALIDATION_ERROR", "source_not_attached");
  const revisionId = crypto.randomUUID();
  const claims = validated.map((claim, index) => ({
    ...claim,
    id: `${revisionId}-c${String(index).padStart(3, "0")}`,
    evidence: claim.evidence.map((entry, evidenceIndex) => ({
      ...entry,
      id: `${revisionId}-c${String(index).padStart(3, "0")}-e${String(evidenceIndex).padStart(3, "0")}`,
    })),
  }));
  const sourceSetHash = await sha256Hex(
    JSON.stringify(
      sources.map(({ id, textHash, auditReference }) => ({
        id,
        textHash,
        auditReference,
      })),
    ),
  );
  const contentHash = await sha256Hex(
    JSON.stringify({
      brief: input.brief,
      markdown: input.markdown,
      metadata: input.metadata,
      claims: validated,
      openQuestions: input.openQuestions,
      omissions: input.omissions,
    }),
  );
  const revision = {
    id: revisionId,
    projectId: input.projectId,
    contentId: input.contentId,
    version: input.expectedHeadVersion + 1,
    parentRevisionId: current?.id ?? null,
    brief: input.brief,
    markdown: input.markdown,
    metadata: input.metadata,
    contextJson: JSON.stringify(live.snapshot),
    contextVersion: live.contextVersion,
    contextHash: live.contextHash,
    sourceSetHash,
    contentHash,
    sourceIds,
    claims,
    openQuestions: input.openQuestions,
    omissions: input.omissions,
    createdAtMs: Date.now(),
  };
  const checkSet = await createContentCheckSet(
    revision,
    new Map(sources.map((source) => [source.id, source])),
    revision.createdAtMs,
  );
  const write = preparedRevisionWriteSchema.parse({
    mutationId: input.mutationId,
    requestHash,
    expectedHeadVersion: input.expectedHeadVersion,
    expectedContextVersion: live.contextVersion,
    sourceHashes: sources.map(({ id, textHash }) => ({
      sourceId: id,
      textHash,
    })),
    revision,
    checkSet,
  });
  const scope = {
    actor: access.scope,
    membershipId: access.membership?.id ?? null,
  };
  const receipt = await (creating
    ? ContentRepository.createRevision(scope, write)
    : ContentRepository.saveRevision(scope, write));
  await contentAccess(actor, input.projectId);
  if (!receipt.ok) {
    if (receipt.code === "conflict")
      throw new AppError("CONFLICT", "mutation_id_conflict");
    const currentContextVersion = await ContentRepository.getContextVersion(
      actor.organizationId,
      input.projectId,
    );
    if (currentContextVersion !== live.contextVersion)
      throw new AppError("CONFLICT", "context_changed");
    const latestSources = await Promise.all(
      sourceIds.map((id) =>
        ContentSourceService.get(actor, input.projectId, id),
      ),
    );
    if (
      latestSources.some(
        (source, index) => source.textHash !== sources[index].textHash,
      )
    )
      throw new AppError("CONFLICT", "source_changed");
    const head = await ContentRepository.getRevision(
      actor.organizationId,
      input.projectId,
      input.contentId,
    );
    if (!head) throw new AppError("CONFLICT", "context_or_project_changed");
    if (head.version === input.expectedHeadVersion)
      throw new AppError("CONFLICT", "write_guard_changed");
    return {
      ok: false as const,
      code: "revision_conflict" as const,
      currentHeadVersion: head.version,
    };
  }
  const saved = await ContentRepository.getRevisionById(
    actor.organizationId,
    input.projectId,
    receipt.resultId,
  );
  if (!saved) throw new AppError("CONFLICT", "revision_unavailable");
  await contentAccess(actor, input.projectId);
  return { ok: true as const, revision: saved, headVersion: saved.version };
}

async function createBrief(actor: ContentActor, raw: CreateContentBriefInput) {
  const input = createContentBriefInputSchema.parse(raw);
  return save(
    actor,
    {
      ...input,
      contentId: crypto.randomUUID(),
      expectedContextVersion: 0,
      markdown: "",
      metadata: { title: "", slug: "", description: "", schemaSuggestion: "" },
      sourceIds: [],
      claims: [],
      openQuestions: [],
      omissions: [],
    },
    true,
  );
}
async function saveRevision(
  actor: ContentActor,
  raw: SaveContentRevisionInput,
) {
  return save(actor, saveContentRevisionInputSchema.parse(raw), false);
}

async function archive(actor: ContentActor, raw: ArchiveContentInput) {
  const input = archiveContentInputSchema.parse(raw);
  const access = await contentAccess(actor, input.projectId);
  const receipt = await ContentRepository.archive(
    { actor: access.scope, membershipId: access.membership?.id ?? null },
    { input, requestHash: await sha256Hex(JSON.stringify(input)) },
  );
  await contentAccess(actor, input.projectId);
  if (!receipt.ok) throw new AppError("CONFLICT", receipt.code);
  return {
    ok: true as const,
    contentId: receipt.resultId,
    replayed: receipt.replayed,
  };
}

async function listRevisions(
  actor: ContentActor,
  raw: ListContentRevisionsInput,
) {
  const input = listContentRevisionsInputSchema.parse(raw);
  await contentAccess(actor, input.projectId);
  const result = await ContentRepository.listRevisions(
    actor.organizationId,
    input.projectId,
    input.contentId,
    { cursor: input.cursor, limit: input.limit },
  );
  await contentAccess(actor, input.projectId);
  return result;
}

async function list(actor: ContentActor, raw: ListContentInput) {
  const input = listContentInputSchema.parse(raw);
  await contentAccess(actor, input.projectId);
  const result = await ContentRepository.list(actor.organizationId, input);
  await contentAccess(actor, input.projectId);
  return result;
}

export const ContentService = {
  createBrief,
  saveRevision,
  getRevision,
  archive,
  listRevisions,
  list,
  getRevisionStatus,
} as const;
