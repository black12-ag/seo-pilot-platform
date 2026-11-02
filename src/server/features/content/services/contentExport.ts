import { sort } from "remeda";
import { sha256Hex } from "@/server/lib/audit/ids";
import { ContentRepository } from "@/server/features/content/repositories/ContentRepository";
import { ContentReviewRepository } from "@/server/features/content/repositories/ContentReviewRepository";
import { AppError } from "@/server/lib/errors";
import {
  exportContentRevisionInputSchema,
  type ContentActor,
  type ExportContentRevisionInput,
} from "@/types/schemas/content";
import { contentAccess } from "./contentAccess";
import { ContentService } from "./ContentService";
import { ContentReviewService } from "./ContentReviewService";
import type { SavedContentRevision } from "@/types/schemas/content";
import type {
  SavedContentCheckSet,
  SavedContentSource,
} from "@/types/schemas/contentEvidence";
import type { SavedContentReview } from "@/types/schemas/contentReview";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${sort(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    )
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function exportContent(
  input: {
    revision: SavedContentRevision;
    sources: SavedContentSource[];
    checks: SavedContentCheckSet | null;
    review: SavedContentReview | null;
    unavailableSourceIds?: string[];
    eligibility?: { eligible: boolean; reason?: string };
  },
  format: "markdown" | "json",
  nowMs: number,
) {
  const { contextJson: _privateContext, ...revision } = input.revision;
  const payload = {
    revision,
    sources: input.sources,
    checks: input.checks,
    review: input.review,
    unavailableSourceIds: input.unavailableSourceIds ?? [],
    eligibility: input.eligibility ?? {
      eligible: false,
      reason: "not_assessed",
    },
  };
  const payloadJson = canonical(payload);
  const manifest = {
    schemaVersion: 1,
    scope: "canonical-json-payload-v1" as const,
    payloadSha256: await sha256Hex(payloadJson),
    payloadBytes: new TextEncoder().encode(payloadJson).byteLength,
    exportedAtMs: nowMs,
    contentHash: revision.contentHash,
    contextHash: revision.contextHash,
    sourceSetHash: revision.sourceSetHash,
    checkSetHash: input.checks?.checkSetHash ?? null,
  };
  const content =
    format === "json"
      ? JSON.stringify({ manifest, payload }, null, 2)
      : [
          revision.markdown,
          "",
          "---",
          "## Content export details",
          "",
          "This export records the chosen revision and does not itself authorize publication.",
          "",
          `Revision: ${revision.id} (version ${revision.version})`,
          `Locale: ${revision.brief.locale.language} / ${revision.brief.locale.country}`,
          `Recorded review status: ${input.review?.state ?? "not requested"}; current eligibility must be checked separately.`,
          "",
          "### Metadata, sources, claims, checks and review",
          "",
          "```json",
          JSON.stringify({ manifest, payload }, null, 2).replaceAll(
            "```",
            "\\u0060\\u0060\\u0060",
          ),
          "```",
          "",
        ].join("\n");
  return {
    filename: `content-${revision.contentId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${revision.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format === "json" ? "json" : "md"}`,
    contentType:
      format === "json" ? "application/json" : "text/markdown; charset=utf-8",
    content,
    bytes: new TextEncoder().encode(content).byteLength,
    sha256: await sha256Hex(content),
    manifest,
  };
}

async function exportRevision(
  actor: ContentActor,
  raw: ExportContentRevisionInput,
) {
  const input = exportContentRevisionInputSchema.parse(raw);
  await contentAccess(actor, input.projectId);
  const read = await ContentService.getRevision(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    revisionId: input.revisionId,
  });
  const review = await ContentReviewRepository.getReviewForRevision(
    actor.organizationId,
    input.projectId,
    input.contentId,
    input.revisionId,
  );
  const current = await ContentReviewService.currentEligibility(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    revisionId: input.revisionId,
    expectedHeadVersion: read.revision.version,
  });
  const eligibility = current.eligible
    ? { eligible: true }
    : { eligible: false, reason: current.reason };
  const artifact = await exportContent(
    {
      revision: read.revision,
      sources: read.sources.flatMap((entry) =>
        entry.source ? [entry.source] : [],
      ),
      unavailableSourceIds: read.sources
        .filter((entry) => entry.state === "unavailable")
        .map((entry) => entry.sourceId),
      checks: read.checks,
      review,
      eligibility,
    },
    input.format,
    Date.now(),
  );
  const status = await ContentRepository.getRevisionStatus(
    actor.organizationId,
    input.projectId,
    input.contentId,
    input.revisionId,
  );
  if (!status || status.redactedAtMs !== null)
    throw new AppError("CONFLICT", "revision_erased");
  await contentAccess(actor, input.projectId);
  return artifact;
}

export const ContentExportService = { exportRevision } as const;
