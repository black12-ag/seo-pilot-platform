import { sort } from "remeda";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
// The migration-applied fixture must exist before static service imports.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => true,
}));
import { exportContent, ContentExportService } from "./contentExport";
import { ContentService } from "./ContentService";
import type { SavedContentRevision } from "@/types/schemas/content";

beforeEach(testDb.seedProject);
afterAll(testDb.close);
const envelopeSchema = z.looseObject({
  payload: z.looseObject({
    revision: z.looseObject({ id: z.string(), markdown: z.string() }),
    eligibility: z.unknown(),
  }),
  manifest: z.looseObject({
    payloadBytes: z.number(),
    payloadSha256: z.string(),
  }),
});

const revision: SavedContentRevision = {
  id: "revision",
  projectId: "project",
  contentId: "content",
  version: 1,
  parentRevisionId: null,
  brief: {
    target: "",
    objective: "",
    audience: "",
    outputKind: "article",
    topic: "Tea",
    locale: { language: "am", country: "ET" },
  },
  markdown: "# ሰላም 😀\n\nComplete body.\n\n```text\nquote\n```",
  metadata: {
    title: "Tea",
    slug: "tea",
    description: "",
    schemaSuggestion: "",
  },
  contextJson: '{"private":"do not export"}',
  contextVersion: 1,
  contextHash: "context",
  sourceSetHash: "sources",
  contentHash: "content-hash",
  sourceIds: [],
  claims: [],
  openQuestions: ["Question?"],
  omissions: [],
  authorUserId: "user",
  surface: "web",
  createdAtMs: 1000,
};

describe("portable content export", () => {
  it("exports only a scoped saved revision with explicit eligibility", async () => {
    const actor = {
      userId: "user",
      organizationId: "organization",
      role: "owner",
      surface: "web",
    } as const;
    const created = await ContentService.createBrief(actor, {
      projectId: "project",
      mutationId: "create",
      expectedHeadVersion: 0,
      brief: revision.brief,
    });
    if (!created.ok) throw new Error("create failed");
    const input = {
      projectId: "project",
      contentId: created.revision.contentId,
      revisionId: created.revision.id,
      format: "json",
    } as const;
    const exported = await ContentExportService.exportRevision(actor, input);
    const envelope = envelopeSchema.parse(JSON.parse(exported.content));
    expect(envelope.payload.revision.id).toBe(created.revision.id);
    expect(envelope.payload.eligibility).toEqual({
      eligible: false,
      reason: "review_missing",
    });
    await testDb.execute(
      `INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('foreign-member','foreign','user','owner',${testDb.provider === "postgres" ? "now()" : "0"})`,
    );
    await expect(
      ContentExportService.exportRevision(
        { ...actor, organizationId: "foreign" },
        input,
      ),
    ).rejects.toThrow();
    await testDb.execute(
      "update content_revisions set redacted_at_ms = 1 where project_id = 'project'",
    );
    await expect(
      ContentExportService.exportRevision(actor, input),
    ).rejects.toThrow("revision_erased");
  });
  it.each(["json", "markdown"] as const)(
    "exports complete %s bytes with an independent download hash",
    async (format) => {
      const artifact = await exportContent(
        { revision, sources: [], checks: null, review: null },
        format,
        2000,
      );
      expect(artifact.content).toContain("# ሰላም 😀");
      expect(artifact.content).toContain("Question?");
      expect(artifact.content).not.toContain("do not export");
      expect(artifact.bytes).toBe(
        new TextEncoder().encode(artifact.content).byteLength,
      );
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(artifact.content),
      );
      expect(artifact.sha256).toBe(
        Array.from(new Uint8Array(hash), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join(""),
      );
      expect(artifact.manifest.scope).toBe("canonical-json-payload-v1");
      const envelope = envelopeSchema.parse(
        JSON.parse(
          format === "json"
            ? artifact.content
            : artifact.content.slice(
                artifact.content.lastIndexOf("```json\n") + 8,
                artifact.content.lastIndexOf("\n```"),
              ),
        ),
      );
      expect(envelope.payload.revision.markdown).toBe(revision.markdown);
      const canonicalPayload = JSON.stringify(
        envelope.payload,
        (_key, value: unknown) =>
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                sort(Object.entries(value), ([a], [b]) =>
                  a < b ? -1 : a > b ? 1 : 0,
                ),
              )
            : value,
      );
      const payloadBytes = new TextEncoder().encode(canonicalPayload);
      const payloadHash = await crypto.subtle.digest("SHA-256", payloadBytes);
      expect(envelope.manifest.payloadBytes).toBe(payloadBytes.byteLength);
      expect(envelope.manifest.payloadSha256).toBe(
        Array.from(new Uint8Array(payloadHash), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join(""),
      );
    },
  );
});
