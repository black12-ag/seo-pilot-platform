import { describe, expect, it, vi } from "vitest";
import { readBoundedText } from "./read-bounded-text";

describe("readBoundedText", () => {
  it("retains the two megabyte default and decodes split UTF-8", async () => {
    const bytes = new TextEncoder().encode("é");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1));
          controller.close();
        },
      }),
    );
    await expect(readBoundedText(response)).resolves.toBe("é");
    expect(response.body?.locked).toBe(false);
    await expect(readBoundedText(new Response("\uFEFFtext"))).resolves.toBe(
      "text",
    );
    await expect(
      readBoundedText(new Response("x".repeat(2_000_001))),
    ).resolves.toBeNull();
  });

  it("cancels oversized chunks despite a lying content length and releases the lock", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1025));
        },
        cancel,
      }),
      { headers: { "content-length": "1" } },
    );
    await expect(readBoundedText(response, 1024)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("cancels stalled reads when aborted without waiting for cancellation acknowledgement", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }));
    const reading = readBoundedText(response, 1024, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("cancels a body supplied with an already-aborted signal", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(
      readBoundedText(response, 1024, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
