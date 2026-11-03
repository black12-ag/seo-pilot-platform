import { useEffect, useRef, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Label } from "@/client/components/ui/label";
import { Textarea } from "@/client/components/ui/textarea";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import {
  captureContentUrlsInputSchema,
  CONTENT_SOURCE_BYTES,
  CONTENT_URL_SOURCE_LIMIT,
  CONTENT_URL_SOURCE_OPERATION_TIMEOUT_MS,
  CONTENT_URL_SOURCE_REDIRECT_LIMIT,
  CONTENT_URL_SOURCE_RESPONSE_BYTES,
  CONTENT_URL_SOURCE_TIMEOUT_MS,
  type CaptureContentUrlsInput,
  type CaptureContentUrlsResult,
  type ContentUrlCaptureOutcome,
} from "@/types/schemas/contentSourceIntake";

type Request = CaptureContentUrlsInput["requests"][number];

export function ContentUrlCapture({
  projectId,
  onCapture,
  onDirtyChange,
}: {
  projectId: string;
  onCapture: (requests: Request[]) => Promise<CaptureContentUrlsResult>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [outcomes, setOutcomes] = useState<ContentUrlCaptureOutcome[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef<Request[]>([]);
  const knownRequests = useRef(new Map<string, Request>());
  const lastRequest = useRef<{
    requests: Request[];
    replaceId?: string;
  } | null>(null);
  useEffect(
    () => onDirtyChange(text !== submitted),
    [onDirtyChange, submitted, text],
  );

  async function run(requests: Request[], replaceId?: string) {
    setPending(true);
    setError(null);
    lastRequest.current = { requests, replaceId };
    try {
      const result = await onCapture(requests);
      setOutcomes((current) =>
        replaceId
          ? current.map((entry) =>
              entry.mutationId === replaceId ? result.outcomes[0] : entry,
            )
          : result.outcomes,
      );
      if (replaceId)
        attempts.current = attempts.current.map((item) =>
          item.mutationId === replaceId ? requests[0] : item,
        );
      else setSubmitted(text);
      lastRequest.current = null;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not capture URLs.",
      );
    } finally {
      setPending(false);
    }
  }

  function submit() {
    const urls = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const used = new Set<number>();
    const requests = urls.map((url) => {
      const index = attempts.current.findIndex(
        (entry, i) => entry.url === url && !used.has(i),
      );
      if (index >= 0) {
        used.add(index);
        return attempts.current[index];
      }
      return { url, mutationId: crypto.randomUUID() };
    });
    const parsed = captureContentUrlsInputSchema.safeParse({
      projectId,
      requests,
    });
    if (!parsed.success) {
      setError(
        `Enter 1–${CONTENT_URL_SOURCE_LIMIT} valid public HTTP(S) URLs, one per line.`,
      );
      return;
    }
    attempts.current = parsed.data.requests;
    for (const request of parsed.data.requests)
      knownRequests.current.set(request.mutationId, request);
    void run(parsed.data.requests);
  }

  function newCapture(entry: ContentUrlCaptureOutcome) {
    const old = knownRequests.current.get(entry.mutationId);
    if (!old) return;
    const request = { ...old, mutationId: crypto.randomUUID() };
    knownRequests.current.set(request.mutationId, request);
    void run([request], old.mutationId);
  }

  return (
    <section
      className="space-y-3 border-t pt-4"
      aria-labelledby="public-urls-title"
    >
      <h3 id="public-urls-title" className="text-sm font-semibold">
        Public URLs
      </h3>
      <p className="text-muted-foreground text-sm">
        Up to {CONTENT_URL_SOURCE_LIMIT} URLs, one per line. Each permits{" "}
        {CONTENT_URL_SOURCE_REDIRECT_LIMIT} redirects,{" "}
        {CONTENT_URL_SOURCE_RESPONSE_BYTES / 1024 / 1024} MiB response and{" "}
        {CONTENT_SOURCE_BYTES / 1024} KiB extracted text;{" "}
        {CONTENT_URL_SOURCE_TIMEOUT_MS / 1000} seconds per URL and{" "}
        {CONTENT_URL_SOURCE_OPERATION_TIMEOUT_MS / 1000} seconds fetch budget
        per batch.
      </p>
      <p className="text-muted-foreground text-sm">
        Unchanged entries reuse saved captures. Use New capture to fetch again.
      </p>
      <Label htmlFor="content-public-urls">Public URLs</Label>
      <Textarea
        id="content-public-urls"
        className="min-h-28 max-h-48"
        value={text}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={
            pending ||
            !text.trim() ||
            (text === submitted && outcomes.length > 0)
          }
          onClick={submit}
        >
          {pending ? "Capturing…" : "Capture URLs"}
        </Button>
        {error && lastRequest.current ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              const retry = lastRequest.current;
              if (retry) void run(retry.requests, retry.replaceId);
            }}
          >
            Retry same capture
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error} Your entries are still here.
        </p>
      ) : null}
      <div aria-live="polite" className="space-y-3">
        {outcomes.map((entry) => (
          <article
            key={entry.mutationId}
            className="space-y-1 rounded-md border p-3 text-sm"
          >
            {entry.state === "unavailable" ? (
              <>
                <p>Capture unavailable: privacy erased.</p>
                <p>
                  Requested entry:{" "}
                  {knownRequests.current.get(entry.mutationId)?.url ??
                    "unknown"}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">
                  {entry.title || "Public URL"} · {entry.extractionStatus}
                  {entry.extractionReason
                    ? ` · ${entry.extractionReason.replaceAll("_", " ")}`
                    : ""}
                </p>
                <p>
                  Requested:{" "}
                  <SafeExternalLink
                    url={entry.urlCapture.requestedUrl}
                    label={entry.urlCapture.requestedUrl}
                    className="inline break-all underline [&_svg]:inline"
                  />
                </p>
                <details>
                  <summary className="cursor-pointer font-medium">
                    Capture details
                  </summary>
                  <p>
                    Resolved:{" "}
                    {entry.urlCapture.resolvedUrl ? (
                      <SafeExternalLink
                        url={entry.urlCapture.resolvedUrl}
                        label={entry.urlCapture.resolvedUrl}
                        className="inline break-all underline [&_svg]:inline"
                      />
                    ) : (
                      "unknown"
                    )}
                  </p>
                  <p>
                    Captured: {new Date(entry.capturedAtMs).toLocaleString()} ·
                    Publisher date: {entry.publisherDate ?? "unknown"}
                  </p>
                  <p>
                    Language: {entry.language ?? "unknown"} · Market:{" "}
                    {entry.market ?? "unknown"}
                  </p>
                  <p>
                    Fetch attempted:{" "}
                    {entry.urlCapture.fetchAttempted ? "yes" : "no"} · HTTP
                    status: {entry.urlCapture.httpStatus ?? "unknown"} ·
                    Redirects: {entry.urlCapture.redirectCount}
                  </p>
                  <p>
                    Response complete:{" "}
                    {entry.urlCapture.responseComplete ? "yes" : "no"} · Text
                    truncated: {entry.urlCapture.textTruncated ? "yes" : "no"} ·
                    Extracted bytes: {entry.urlCapture.extractedBytes}
                  </p>
                  <p>
                    Method: {entry.extractionMethod} · {entry.extractionVersion}
                  </p>
                </details>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => newCapture(entry)}
                >
                  New capture
                </Button>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
