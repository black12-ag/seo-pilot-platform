import { ContentEvidenceRepository } from "@/server/features/content/repositories/ContentEvidenceRepository";
import { preparedSourceWriteSchema } from "@/server/features/content/repositories/contentRevisionWrites";
import { contentAccess } from "./contentAccess";
import { captureUrls } from "./contentUrlCapture";
import {
  CONTENT_SOURCE_BYTES,
  CONTENT_URL_SOURCE_RESPONSE_BYTES,
} from "@/types/schemas/contentSourceIntake";
import { sha256Hex } from "@/server/lib/audit/ids";
import { AppError } from "@/server/lib/errors";
import {
  listContentSourcesInputSchema,
  type ContentActor,
  type ListContentSourcesInput,
} from "@/types/schemas/content";
import {
  captureContentSourceInputSchema,
  savedContentSourceSchema,
  type CaptureContentSourceInput,
} from "@/types/schemas/contentEvidence";

async function capture(actor: ContentActor, raw: CaptureContentSourceInput) {
  const input = captureContentSourceInputSchema.parse(raw);
  const access = await contentAccess(actor, input.projectId);
  const requestHash = await sha256Hex(JSON.stringify(input));
  const nowMs = Date.now();
  let source;
  if (input.source.kind === "pasted") {
    source = {
      ...input.source,
      sourceText: input.source.text,
      auditReference: null,
      urlCapture: null,
      extractionMethod: "owner_paste",
      extractionVersion: "1",
      extractionStatus: input.source.text.length ? "usable" : "empty",
      extractionReason: input.source.text.length ? null : "empty_text",
    };
  } else {
    const observation = await ContentEvidenceRepository.getAuditObservation(
      actor.organizationId,
      input.projectId,
      input.source,
    );
    if (!observation)
      throw new AppError(
        "VALIDATION_ERROR",
        "audit_observation_unavailable_or_issue_page_required",
      );
    source = {
      kind: "audit" as const,
      title: observation.issue
        ? `Audit issue: ${observation.issue.issueType}`
        : "Audit observation",
      attribution: "Project audit",
      sourceText: JSON.stringify(observation),
      publisherDate: null,
      language: null,
      market: null,
      urlCapture: null,
      auditReference: {
        auditId: input.source.auditId,
        pageId: observation.page?.id ?? null,
        issueId: input.source.issueId,
      },
      extractionMethod: "typed_audit_observation",
      extractionVersion: "1",
      extractionStatus: "usable",
      extractionReason: null,
    };
  }
  const prepared = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    kind: source.kind,
    title: source.title,
    attribution: source.attribution,
    sourceText: source.sourceText,
    textHash: await sha256Hex(source.sourceText),
    capturedAtMs: nowMs,
    publisherDate: source.publisherDate,
    language: source.language,
    market: source.market,
    extractionMethod: source.extractionMethod,
    extractionVersion: source.extractionVersion,
    extractionStatus: source.extractionStatus,
    extractionReason: source.extractionReason,
    auditReference: source.auditReference,
    urlCapture: source.urlCapture,
  };
  const write = preparedSourceWriteSchema.parse({
    mutationId: input.mutationId,
    requestHash,
    source: prepared,
  });
  const receipt = await ContentEvidenceRepository.captureSource(
    { actor: access.scope, membershipId: access.membership?.id ?? null },
    write,
  );
  await contentAccess(actor, input.projectId);
  if (!receipt.ok) throw new AppError("CONFLICT", receipt.code);
  return {
    source: await get(actor, input.projectId, receipt.resultId),
    replayed: receipt.replayed,
  };
}

async function get(actor: ContentActor, projectId: string, sourceId: string) {
  await contentAccess(actor, projectId);
  const stored = await ContentEvidenceRepository.getSource(
    actor.organizationId,
    projectId,
    sourceId,
  );
  if (
    !stored ||
    stored.source.extractionStatus === "erased" ||
    (stored.source.kind === "audit" && !stored.auditReference) ||
    (stored.source.kind === "web" &&
      (!stored.urlCapture ||
        !["usable", "partial"].includes(stored.source.extractionStatus)))
  )
    throw new AppError("CONFLICT", "source_unavailable");
  const { mutationReceiptId: _receiptId, ...publicSource } = stored.source;
  const source = savedContentSourceSchema.parse({
    ...publicSource,
    urlCapture: stored.urlCapture && {
      requestedUrl: stored.urlCapture.requestedUrl,
      resolvedUrl: stored.urlCapture.resolvedUrl,
      httpStatus: stored.urlCapture.httpStatus,
      redirectCount: stored.urlCapture.redirectCount,
      fetchAttempted: Boolean(stored.urlCapture.fetchAttempted),
      responseComplete: Boolean(stored.urlCapture.responseComplete),
      textTruncated: Boolean(stored.urlCapture.textTruncated),
      extractedBytes: stored.urlCapture.extractedBytes,
      responseByteLimit: CONTENT_URL_SOURCE_RESPONSE_BYTES,
      extractedByteLimit: CONTENT_SOURCE_BYTES,
    },
    auditReference: stored.auditReference && {
      auditId: stored.auditReference.auditId,
      pageId: stored.auditReference.pageId,
      issueId: stored.auditReference.issueId,
    },
  });
  if ((await sha256Hex(source.sourceText)) !== source.textHash)
    throw new AppError("CONFLICT", "source_integrity_mismatch");
  await contentAccess(actor, projectId);
  return source;
}

async function list(actor: ContentActor, raw: ListContentSourcesInput) {
  const input = listContentSourcesInputSchema.parse(raw);
  await contentAccess(actor, input.projectId);
  const result = await ContentEvidenceRepository.listSources(
    actor.organizationId,
    input.projectId,
    { cursor: input.cursor, limit: input.limit },
  );
  await contentAccess(actor, input.projectId);
  return result;
}

export const ContentSourceService = {
  capture,
  captureUrls,
  get,
  list,
} as const;
