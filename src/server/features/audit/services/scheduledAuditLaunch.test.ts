import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ env: {} }));
import {
  createScheduledWorkflow,
  observeScheduledWorkflow,
} from "./scheduledAuditLaunch";

function workflow(initial: string | Error) {
  let current = initial;
  const create = vi.fn(async () => {
    current = "complete";
    throw new Error("reply lost");
  });
  const binding = {
    create,
    get: vi.fn(async () => {
      if (current instanceof Error) throw current;
      return { status: async () => ({ status: current }) };
    }),
  };
  // Only create/get/status are used from the runtime binding.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { binding: binding as unknown as Workflow<object>, create };
}

describe("scheduled workflow identity", () => {
  it.each(["complete", "errored", "terminated"])(
    "recognizes existing %s as terminal rather than absent",
    async (status) => {
      const engine = workflow(status);
      expect(
        await observeScheduledWorkflow(engine.binding, "stable-slot"),
      ).toEqual({
        state: "terminal",
        status,
      });
      expect(engine.create).not.toHaveBeenCalled();
    },
  );

  it.each(["queued", "running", "waiting", "waitingForPause", "paused"])(
    "recognizes %s as an existing launch",
    async (status) => {
      const engine = workflow(status);
      expect(
        await observeScheduledWorkflow(engine.binding, "stable-slot"),
      ).toEqual({
        state: "active",
        status,
      });
    },
  );

  it.each([
    new Error("upstream 404 not found"),
    new Error("timeout"),
    "unknown",
  ])(
    "does not mistake unavailable control-plane state for absence (%s)",
    async (status) => {
      const engine = workflow(status);
      expect(
        await observeScheduledWorkflow(engine.binding, "stable-slot"),
      ).toEqual({ state: "unknown" });
      expect(engine.create).not.toHaveBeenCalled();
    },
  );

  it("recognizes the pinned celld v0.5.1 binding absence signal", async () => {
    // celld harness __wfStatus -> __wfError; the binding preserves this message.
    const engine = workflow(
      new Error("WORKFLOW_ERROR: instance does not exist"),
    );
    expect(
      await observeScheduledWorkflow(engine.binding, "stable-slot"),
    ).toEqual({ state: "missing" });
    expect(engine.create).not.toHaveBeenCalled();
  });

  it("reattaches the same ID after a lost create reply and immediate completion", async () => {
    const engine = workflow(new Error("instance.not_found"));
    expect(
      await observeScheduledWorkflow(engine.binding, "stable-slot"),
    ).toEqual({ state: "missing" });
    expect(
      await createScheduledWorkflow(engine.binding, {
        id: "stable-slot",
        params: {},
      }),
    ).toEqual({ state: "terminal", status: "complete" });
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(engine.create).toHaveBeenCalledWith({
      id: "stable-slot",
      params: {},
    });
  });
});
