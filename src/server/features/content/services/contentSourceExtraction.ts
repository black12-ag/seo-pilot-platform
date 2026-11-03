import { Parser } from "htmlparser2";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { publicFetch } from "@/server/lib/public-fetch";
import { readBoundedText } from "@/server/lib/read-bounded-text";
import { getOptionalEnvValue, getWorkersEnv } from "@/server/lib/runtime-env";
import {
  CONTENT_SOURCE_BYTES,
  CONTENT_URL_SOURCE_MAX_LENGTH,
  CONTENT_URL_SOURCE_REDIRECT_LIMIT,
  CONTENT_URL_SOURCE_RESPONSE_BYTES,
  CONTENT_URL_SOURCE_TIMEOUT_MS,
  type PublicSourceExtraction,
  type PublicSourceReason,
  type PublicSourceStatus,
} from "@/types/schemas/contentSourceIntake";

const suppressed = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "embed",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
]);
const blocks = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "main",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
]);
const redirects = new Set([301, 302, 303, 307, 308]);
const encoder = new TextEncoder();

function safeUrl(value: string): string {
  if (
    value.length > CONTENT_URL_SOURCE_MAX_LENGTH ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error("invalid URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("invalid URL");
  return url.href;
}

function truncateText(value: string) {
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > CONTENT_SOURCE_BYTES)
      return { text: result, bytes, truncated: true };
    result += char;
    bytes += size;
  }
  return { text: result, bytes, truncated: false };
}

const clean = (parts: string[]) => parts.join("").replace(/\s+/gu, " ").trim();

function parseHtml(html: string, signal: AbortSignal) {
  let depth = 0,
    preferredDepth = 0,
    titleDepth = 0;
  let title = "",
    publisherDate: string | null = null,
    language: string | null = null,
    market: string | null = null;
  const all: string[] = [],
    preferred: string[] = [];
  const add = (text: string) => {
    if (depth) return;
    all.push(text);
    if (preferredDepth) preferred.push(text);
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      signal.throwIfAborted();
      if (name === "html" && attrs.lang) {
        try {
          const locale = new Intl.Locale(attrs.lang);
          language = locale.language;
          market = locale.region ?? null;
        } catch {
          /* Undeclared or invalid locale stays unknown. */
        }
      }
      if (
        name === "meta" &&
        (attrs.property?.toLowerCase() === "article:published_time" ||
          attrs.itemprop?.toLowerCase() === "datepublished")
      ) {
        const value = attrs.content?.trim();
        if (
          !publisherDate &&
          value &&
          value.length <= 50 &&
          /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
            value,
          ) &&
          !Number.isNaN(Date.parse(value)) &&
          new Date(`${value.slice(0, 10)}T00:00:00Z`)
            .toISOString()
            .slice(0, 10) === value.slice(0, 10)
        )
          publisherDate = value;
      }
      if (name === "title") titleDepth++;
      if (suppressed.has(name)) depth++;
      if (!depth && (name === "main" || name === "article")) preferredDepth++;
      if (blocks.has(name)) add(" ");
    },
    ontext(text) {
      signal.throwIfAborted();
      if (titleDepth) title += text;
      else add(text);
    },
    onclosetag(name) {
      signal.throwIfAborted();
      if (blocks.has(name)) add(" ");
      if (!depth && (name === "main" || name === "article") && preferredDepth)
        preferredDepth--;
      if (suppressed.has(name) && depth) depth--;
      if (name === "title" && titleDepth) titleDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return {
    text: clean(preferred) || clean(all),
    title: title.replace(/\s+/gu, " ").trim().slice(0, 500),
    publisherDate,
    language,
    market,
  };
}

export async function extractPublicSource(input: {
  requestedUrl: string;
  signal: AbortSignal;
}): Promise<PublicSourceExtraction> {
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const timer = setTimeout(() => {
    expired = true;
    abort();
  }, CONTENT_URL_SOURCE_TIMEOUT_MS);
  let result: PublicSourceExtraction = {
    requestedUrl: input.requestedUrl,
    resolvedUrl: null,
    capturedAtMs: Date.now(),
    httpStatus: null,
    redirectCount: 0,
    fetchAttempted: false,
    responseComplete: false,
    textTruncated: false,
    extractedBytes: 0,
    extractionStatus: "failed",
    extractionReason: "network_error",
    extractionMethod: "public_fetch",
    extractionVersion: "public-source-v1",
    title: "",
    sourceText: "",
    publisherDate: null,
    language: null,
    market: null,
  };
  const finish = (
    status: PublicSourceStatus,
    reason: PublicSourceReason | null,
  ): PublicSourceExtraction => ({
    ...result,
    capturedAtMs: Date.now(),
    extractionStatus: status,
    extractionReason: reason,
  });
  const cancelled = new Promise<PublicSourceExtraction>((resolve) => {
    const done = () =>
      resolve(finish("failed", expired ? "timeout" : "operation_deadline"));
    controller.signal.addEventListener("abort", done, { once: true });
    if (controller.signal.aborted) done();
  });
  const readContent = async (
    response: Response,
    current: string,
  ): Promise<PublicSourceExtraction> => {
    const contentType = response.headers.get("content-type") ?? "";
    const [mime, ...params] = contentType
      .split(";")
      .map((part) => part.trim().toLowerCase());
    if (!["text/html", "application/xhtml+xml", "text/plain"].includes(mime))
      return finish("blocked", "unsupported_mime");
    const charset = params
      .find((part) => /^charset\s*=/.test(part))
      ?.replace(/^charset\s*=\s*/, "")
      .replace(/^"|"$/g, "");
    if (charset && !["utf-8", "us-ascii"].includes(charset))
      return finish("blocked", "unsupported_charset");
    result.extractionMethod =
      mime === "text/plain" ? "public_plain_text" : "public_html_text";
    if (!response.body) return finish("empty", "no_body");
    const body = await readBoundedText(
      response,
      CONTENT_URL_SOURCE_RESPONSE_BYTES,
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (body === null) return finish("failed", "body_too_large");
    result.responseComplete = true;
    let parsed;
    try {
      controller.signal.throwIfAborted();
      parsed =
        mime === "text/plain"
          ? {
              text: body.trim(),
              title: "",
              publisherDate: null,
              language: null,
              market: null,
            }
          : parseHtml(body, controller.signal);
      controller.signal.throwIfAborted();
    } catch {
      controller.signal.throwIfAborted();
      return finish("failed", "parse_error");
    }
    result.title = parsed.title || new URL(current).hostname;
    const text = truncateText(parsed.text);
    result.sourceText = text.text;
    result.extractedBytes = text.bytes;
    result.textTruncated = text.truncated;
    if (!text.text) return finish("empty", "empty_text");
    result.publisherDate = parsed.publisherDate;
    result.language = parsed.language;
    result.market = parsed.market;
    if (text.truncated) return finish("partial", "extracted_text_limit");
    if (response.status === 206) return finish("partial", "http_partial");
    if (Array.from(text.text).length < 200)
      return finish("partial", "thin_text");
    return finish("usable", null);
  };
  const work = async (): Promise<PublicSourceExtraction> => {
    let response: Response | undefined;
    try {
      let current: string;
      try {
        current = safeUrl(input.requestedUrl);
      } catch {
        return finish("blocked", "blocked_target");
      }
      controller.signal.throwIfAborted();
      const workers = await getWorkersEnv();
      const gateway = await getOptionalEnvValue("CRAWL_GATEWAY_URL");
      const secret = gateway
        ? await getOptionalEnvValue("CRAWL_GATEWAY_SECRET")
        : undefined;
      controller.signal.throwIfAborted();
      if (
        ((import.meta.env.MODE === "standalone" || !workers) && !gateway) ||
        (gateway && !secret)
      )
        return finish("failed", "transport_unavailable");
      while (true) {
        try {
          current = safeUrl(await normalizeAndValidateStartUrl(current));
          controller.signal.throwIfAborted();
        } catch {
          controller.signal.throwIfAborted();
          return finish(
            "blocked",
            result.redirectCount ? "redirect_target_blocked" : "blocked_target",
          );
        }
        result.fetchAttempted = true;
        response = await publicFetch(current, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: {
            "user-agent": "OpenSEO-PublicSource/1.0",
            Accept: "text/html, application/xhtml+xml, text/plain",
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        result.resolvedUrl = current;
        result.httpStatus = response.status;
        if (response.redirected) return finish("failed", "unexpected_redirect");
        if (redirects.has(response.status)) {
          const location = response.headers.get("location");
          if (!location) return finish("failed", "redirect_location_missing");
          if (result.redirectCount >= CONTENT_URL_SOURCE_REDIRECT_LIMIT)
            return finish("failed", "redirect_limit");
          try {
            current = safeUrl(new URL(location, current).href);
          } catch {
            return finish("blocked", "redirect_target_blocked");
          }
          result.redirectCount++;
          void response.body?.cancel().catch(() => {});
          response = undefined;
          continue;
        }
        if ([401, 403, 407, 429].includes(response.status))
          return finish("blocked", "http_blocked");
        if (response.status !== 200 && response.status !== 206)
          return finish("failed", "http_error");
        return await readContent(response, current);
      }
    } catch {
      return finish(
        "failed",
        controller.signal.aborted
          ? expired
            ? "timeout"
            : "operation_deadline"
          : "network_error",
      );
    } finally {
      if (response && !response.body?.locked)
        void response.body?.cancel().catch(() => {});
    }
  };
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
