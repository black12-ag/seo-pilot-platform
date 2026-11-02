import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// The migration-applied fixture must exist before static repository imports.
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
import { ContentSourceService } from "./ContentSourceService";

const actor = {
  userId: "user",
  organizationId: "organization",
  role: "owner",
  surface: "web",
} as const;
const input = {
  projectId: "project",
  mutationId: "capture-1",
  source: {
    kind: "pasted",
    title: "Owner",
    attribution: "Owner",
    text: "ሰላም😀",
    publisherDate: null,
    language: null,
    market: null,
  },
} as const;
beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe("content source capture", () => {
  it("stores the exact attributed source and replays the same mutation", async () => {
    const first = await ContentSourceService.capture(actor, input);
    const replay = await ContentSourceService.capture(actor, input);
    expect(first.source).toMatchObject({
      sourceText: "ሰላም😀",
      attribution: "Owner",
      kind: "pasted",
    });
    expect(replay.source.id).toBe(first.source.id);
    expect(replay.replayed).toBe(true);
    await expect(
      ContentSourceService.capture(actor, {
        ...input,
        source: { ...input.source, text: "changed" },
      }),
    ).rejects.toThrow();
  });
  it("rejects over-limit text before creating a capture", async () => {
    await expect(
      ContentSourceService.capture(actor, {
        ...input,
        source: { ...input.source, text: "😀".repeat(25601) },
      }),
    ).rejects.toThrow();
    expect(await testDb.execute("select id from content_sources")).toHaveLength(
      0,
    );
  });
  it("captures only typed observations from the same project", async () => {
    await testDb.executeMultiple(`
      INSERT INTO audits (id, project_id, started_by_user_id, start_url) VALUES
        ('audit', 'project', 'user', 'https://example.com'),
        ('foreign-audit', 'foreign-project', 'user', 'https://other.com');
      INSERT INTO audit_pages (id, audit_id, url) VALUES ('page', 'audit', 'https://example.com/page');
      INSERT INTO audit_issues (id, audit_id, page_id, page_url, issue_type) VALUES ('issue', 'audit', 'page', 'https://example.com/page', 'missing_title');
    `);
    const audit = {
      kind: "audit" as const,
      auditId: "audit",
      pageId: "page",
      issueId: "issue",
    };
    const result = await ContentSourceService.capture(actor, {
      projectId: "project",
      mutationId: "audit-capture",
      source: audit,
    });
    expect(JSON.parse(result.source.sourceText)).toMatchObject({
      issue: { id: "issue", issueType: "missing_title" },
      page: { id: "page" },
    });
    const issueOnly = await ContentSourceService.capture(actor, {
      projectId: "project",
      mutationId: "issue-only",
      source: { ...audit, pageId: null },
    });
    expect(issueOnly.source.auditReference?.pageId).toBe("page");
    await expect(
      ContentSourceService.capture(actor, {
        projectId: "project",
        mutationId: "foreign-capture",
        source: {
          ...audit,
          auditId: "foreign-audit",
          pageId: null,
          issueId: null,
        },
      }),
    ).rejects.toThrow("audit_observation_unavailable");
  });
  it("rejects an oversized audit observation before writing a receipt", async () => {
    await testDb.executeMultiple(`
      INSERT INTO audits (id, project_id, started_by_user_id, start_url) VALUES ('audit', 'project', 'user', 'https://example.com');
      INSERT INTO audit_pages (id, audit_id, url, title) VALUES ('page', 'audit', 'https://example.com/page', '${"x".repeat(102401)}');
    `);
    await expect(
      ContentSourceService.capture(actor, {
        projectId: "project",
        mutationId: "large-audit",
        source: {
          kind: "audit",
          auditId: "audit",
          pageId: "page",
          issueId: null,
        },
      }),
    ).rejects.toThrow();
    expect(
      await testDb.execute("select id from content_mutations"),
    ).toHaveLength(0);
  });
});
