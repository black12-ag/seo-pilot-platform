/** Counts decoded response bytes, independently of Content-Length. */
export async function readBoundedText(
  response: Response,
  maxBytes = 2_000_000,
  signal?: AbortSignal,
  preserveBOM = false,
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: preserveBOM });
  let result = "";
  let bytesRead = 0;
  let finished = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) return null;
      result += decoder.decode(value, { stream: true });
    }
    finished = true;
    return result + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
