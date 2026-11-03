import { ContentEvidenceRepository } from "@/server/features/content/repositories/ContentEvidenceRepository";
import { preparedSourceWriteSchema } from "@/server/features/content/repositories/contentRevisionWrites";
import { sha256Hex } from "@/server/lib/audit/ids";
import { AppError } from "@/server/lib/errors";
import type { ContentActor } from "@/types/schemas/content";
import {
  CONTENT_SOURCE_BYTES,
  CONTENT_URL_SOURCE_OPERATION_TIMEOUT_MS,
  CONTENT_URL_SOURCE_RESPONSE_BYTES,
  captureContentUrlsInputSchema,
  captureContentUrlsResultSchema,
  contentUrlCaptureOutcomeSchema,
  publicSourceExtractionSchema,
  type CaptureContentUrlsInput,
  type ContentUrlCaptureOutcome,
} from "@/types/schemas/contentSourceIntake";
import { contentAccess } from "./contentAccess";
import { extractPublicSource } from "./contentSourceExtraction";

export async function captureUrls(
  actor: ContentActor,
  raw: CaptureContentUrlsInput,
) {
  const deadline = Date.now() + CONTENT_URL_SOURCE_OPERATION_TIMEOUT_MS;
  const input = captureContentUrlsInputSchema.parse(raw);
  const outcomes: ContentUrlCaptureOutcome[] = [];
  for (const request of input.requests) {
    const access = await contentAccess(actor, input.projectId);
    const scope = {
      actor: access.scope,
      membershipId: access.membership?.id ?? null,
    };
    const requestHash = await sha256Hex(
      JSON.stringify({ projectId: input.projectId, ...request }),
    );
    const existing = await ContentEvidenceRepository.lookupCapture(
      scope,
      input.projectId,
      request.mutationId,
    );
    if (existing) {
      if (
        existing.receipt.kind !== "capture" ||
        existing.receipt.completed !== 1
      )
        throw new AppError("CONFLICT", "conflict");
      if (existing.source?.extractionStatus === "erased") {
        outcomes.push({
          state: "unavailable",
          mutationId: request.mutationId,
          sourceId: existing.receipt.resultId,
          replayed: true,
          reason: "privacy_erased",
        });
        continue;
      }
      if (
        existing.receipt.requestHash !== requestHash ||
        existing.source?.kind !== "web"
      )
        throw new AppError("CONFLICT", "conflict");
      outcomes.push(
        await outcome(
          actor,
          input.projectId,
          request.mutationId,
          existing.receipt.resultId,
          true,
        ),
      );
      continue;
    }
    const remaining = deadline - Date.now();
    const result = publicSourceExtractionSchema.parse(
      remaining <= 0
        ? {
            requestedUrl: request.url,
            resolvedUrl: null,
            capturedAtMs: Date.now(),
            httpStatus: null,
            redirectCount: 0,
            fetchAttempted: false,
            responseComplete: false,
            textTruncated: false,
            extractedBytes: 0,
            extractionStatus: "failed",
            extractionReason: "operation_deadline",
            extractionMethod: "public_fetch",
            extractionVersion: "public-source-v1",
            title: "",
            sourceText: "",
            publisherDate: null,
            language: null,
            market: null,
          }
        : await extractPublicSource({
            requestedUrl: request.url,
            signal: AbortSignal.timeout(remaining),
          }),
    );
    await contentAccess(actor, input.projectId);
    const urlCapture = {
      requestedUrl: result.requestedUrl,
      resolvedUrl: result.resolvedUrl,
      httpStatus: result.httpStatus,
      redirectCount: result.redirectCount,
      fetchAttempted: result.fetchAttempted,
      responseComplete: result.responseComplete,
      textTruncated: result.textTruncated,
      extractedBytes: result.extractedBytes,
      responseByteLimit: CONTENT_URL_SOURCE_RESPONSE_BYTES,
      extractedByteLimit: CONTENT_SOURCE_BYTES,
    };
    const write = preparedSourceWriteSchema.parse({
      mutationId: request.mutationId,
      requestHash,
      source: {
        id: crypto.randomUUID(),
        projectId: input.projectId,
        kind: "web",
        title: result.title,
        attribution: new URL(result.resolvedUrl ?? result.requestedUrl)
          .hostname,
        sourceText: result.sourceText,
        textHash: await sha256Hex(result.sourceText),
        capturedAtMs: result.capturedAtMs,
        publisherDate: result.publisherDate,
        language: result.language,
        market: result.market,
        extractionMethod: result.extractionMethod,
        extractionVersion: result.extractionVersion,
        extractionStatus: result.extractionStatus,
        extractionReason: result.extractionReason,
        auditReference: null,
        urlCapture,
      },
    });
    const receipt = await ContentEvidenceRepository.captureSource(scope, write);
    await contentAccess(actor, input.projectId);
    if (!receipt.ok) throw new AppError("CONFLICT", receipt.code);
    outcomes.push(
      await outcome(
        actor,
        input.projectId,
        request.mutationId,
        receipt.resultId,
        receipt.replayed,
      ),
    );
  }
  await contentAccess(actor, input.projectId);
  return captureContentUrlsResultSchema.parse({ outcomes });
}

async function outcome(
  actor: ContentActor,
  projectId: string,
  mutationId: string,
  sourceId: string,
  replayed: boolean,
): Promise<ContentUrlCaptureOutcome> {
  await contentAccess(actor, projectId);
  const stored = await ContentEvidenceRepository.getSource(
    actor.organizationId,
    projectId,
    sourceId,
  );
  await contentAccess(actor, projectId);
  if (stored?.source.extractionStatus === "erased" && replayed)
    return {
      state: "unavailable",
      mutationId,
      sourceId,
      replayed: true,
      reason: "privacy_erased",
    };
  if (!stored || stored.source.kind !== "web" || !stored.urlCapture)
    throw new AppError("CONFLICT", "source_unavailable");
  const u = stored.urlCapture;
  return contentUrlCaptureOutcomeSchema.parse({
    state: "captured",
    mutationId,
    sourceId,
    replayed,
    available: ["usable", "partial"].includes(stored.source.extractionStatus),
    extractionStatus: stored.source.extractionStatus,
    extractionReason: stored.source.extractionReason,
    title: stored.source.title,
    capturedAtMs: stored.source.capturedAtMs,
    publisherDate: stored.source.publisherDate,
    language: stored.source.language,
    market: stored.source.market,
    extractionMethod: stored.source.extractionMethod,
    extractionVersion: stored.source.extractionVersion,
    urlCapture: {
      requestedUrl: u.requestedUrl,
      resolvedUrl: u.resolvedUrl,
      httpStatus: u.httpStatus,
      redirectCount: u.redirectCount,
      fetchAttempted: Boolean(u.fetchAttempted),
      responseComplete: Boolean(u.responseComplete),
      textTruncated: Boolean(u.textTruncated),
      extractedBytes: u.extractedBytes,
      responseByteLimit: CONTENT_URL_SOURCE_RESPONSE_BYTES,
      extractedByteLimit: CONTENT_SOURCE_BYTES,
    },
  });
}
