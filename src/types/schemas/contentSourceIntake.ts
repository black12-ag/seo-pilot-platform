import { z } from "zod";

export const CONTENT_SOURCE_BYTES = 100 * 1024;
export const CONTENT_URL_SOURCE_LIMIT = 5;
export const CONTENT_URL_SOURCE_MAX_LENGTH = 2048;
export const CONTENT_URL_SOURCE_REDIRECT_LIMIT = 3;
export const CONTENT_URL_SOURCE_RESPONSE_BYTES = 1024 * 1024;
export const CONTENT_URL_SOURCE_TIMEOUT_MS = 10_000;
export const CONTENT_URL_SOURCE_OPERATION_TIMEOUT_MS = 30_000;

const id = z.string().min(1).max(255);
const url = z.string().max(CONTENT_URL_SOURCE_MAX_LENGTH);
const status = z.enum(["usable", "partial", "empty", "blocked", "failed"]);
const reason = z.enum([
  "blocked_target",
  "transport_unavailable",
  "redirect_target_blocked",
  "redirect_limit",
  "redirect_location_missing",
  "unexpected_redirect",
  "http_blocked",
  "http_error",
  "unsupported_mime",
  "unsupported_charset",
  "body_too_large",
  "no_body",
  "empty_text",
  "thin_text",
  "extracted_text_limit",
  "http_partial",
  "timeout",
  "operation_deadline",
  "network_error",
  "parse_error",
]);
const metadata = {
  requestedUrl: url,
  resolvedUrl: url.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  redirectCount: z.number().int().min(0).max(CONTENT_URL_SOURCE_REDIRECT_LIMIT),
  fetchAttempted: z.boolean(),
  responseComplete: z.boolean(),
  textTruncated: z.boolean(),
  extractedBytes: z.number().int().min(0).max(CONTENT_SOURCE_BYTES),
};
const extractionFields = {
  extractionStatus: status,
  extractionReason: reason.nullable(),
  extractionMethod: z.enum([
    "public_html_text",
    "public_plain_text",
    "public_fetch",
  ]),
  extractionVersion: z.literal("public-source-v1"),
  title: z.string().max(500),
  publisherDate: z.string().max(50).nullable(),
  language: z.string().max(50).nullable(),
  market: z.string().max(100).nullable(),
};
export const publicSourceExtractionSchema = z
  .strictObject({
    ...metadata,
    ...extractionFields,
    capturedAtMs: z.number().int().nonnegative(),
    sourceText: z.string(),
  })
  .superRefine((value, ctx) => {
    const bytes = new TextEncoder().encode(value.sourceText).byteLength;
    if (bytes !== value.extractedBytes || bytes > CONTENT_SOURCE_BYTES)
      ctx.addIssue({
        code: "custom",
        message: "Invalid extracted byte count",
        path: ["extractedBytes"],
      });
    if (
      (value.extractionStatus === "usable" ||
        value.extractionStatus === "partial") &&
      !value.sourceText.trim()
    )
      ctx.addIssue({
        code: "custom",
        message: "Usable extraction must contain text",
        path: ["sourceText"],
      });
    if (
      value.extractionStatus !== "usable" &&
      value.extractionStatus !== "partial" &&
      (value.sourceText !== "" ||
        value.publisherDate !== null ||
        value.language !== null ||
        value.market !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Nonusable extraction contains content",
      });
  });
export type PublicSourceExtraction = z.infer<
  typeof publicSourceExtractionSchema
>;
export type PublicSourceStatus = z.infer<typeof status>;
export type PublicSourceReason = z.infer<typeof reason>;

const requestUrl = z
  .string()
  .refine(
    (value) =>
      !Array.from(value).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ),
    "Invalid public URL",
  )
  .trim()
  .min(1)
  .max(CONTENT_URL_SOURCE_MAX_LENGTH)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password &&
        (!parsed.port || parsed.port === "80" || parsed.port === "443")
      );
    } catch {
      return false;
    }
  }, "Invalid public URL");
export const captureContentUrlsInputSchema = z
  .strictObject({
    projectId: id,
    requests: z
      .array(z.strictObject({ mutationId: id, url: requestUrl }))
      .min(1)
      .max(CONTENT_URL_SOURCE_LIMIT),
  })
  .refine(
    (value) =>
      new Set(value.requests.map((request) => request.mutationId)).size ===
      value.requests.length,
    {
      message: "Mutation IDs must be distinct",
      path: ["requests"],
    },
  );
export const contentUrlCaptureSchema = z.strictObject({
  ...metadata,
  responseByteLimit: z.literal(CONTENT_URL_SOURCE_RESPONSE_BYTES),
  extractedByteLimit: z.literal(CONTENT_SOURCE_BYTES),
});
export const contentUrlCaptureOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("captured"),
    mutationId: id,
    sourceId: id,
    replayed: z.boolean(),
    available: z.boolean(),
    ...extractionFields,
    capturedAtMs: z.number().int().nonnegative(),
    urlCapture: contentUrlCaptureSchema,
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    mutationId: id,
    sourceId: id,
    replayed: z.literal(true),
    reason: z.literal("privacy_erased"),
  }),
]);
export const captureContentUrlsResultSchema = z.strictObject({
  outcomes: z
    .array(contentUrlCaptureOutcomeSchema)
    .min(1)
    .max(CONTENT_URL_SOURCE_LIMIT),
});
export type CaptureContentUrlsInput = z.infer<
  typeof captureContentUrlsInputSchema
>;
export type ContentUrlCaptureOutcome = z.infer<
  typeof contentUrlCaptureOutcomeSchema
>;
export type CaptureContentUrlsResult = z.infer<
  typeof captureContentUrlsResultSchema
>;
