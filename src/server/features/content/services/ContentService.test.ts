import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { ContentService } from "./ContentService";
import { ContentSourceService } from "./ContentSourceService";
import { ContentReviewService } from "./ContentReviewService";
import { ContentExportService } from "./contentExport";
import { applyContextUpdates } from "@/server/features/project-context/services/ProjectContextService";

const actor = {
  userId: "user",
  organizationId: "organization",
  role: "owner",
  surface: "web",
} as const;
const brief = {
  target: "",
  objective: "",
  audience: "",
  outputKind: "article",
  topic: "Tea",
  locale: { language: "am", country: "ET" },
};
const create = {
  projectId: "project",
  mutationId: "create",
  expectedHeadVersion: 0,
  brief,
} as const;
const metadata = {
  title: "Tea",
  slug: "tea",
  description: "",
  schemaSuggestion: "",
};
beforeEach(testDb.seedProject);
afterAll(testDb.close);
afterEach(() => vi.restoreAllMocks());

describe("manual content", () => {
  it("exposes a scoped tombstone without reading erased content", async () => {
    const created = await ContentService.createBrief(actor, create);
    if (!created.ok) throw new Error("create failed");
    await testDb.execute(
      "update content_revisions set redacted_at_ms = 1 where project_id = 'project'",
    );
    const input = {
      projectId: "project",
      contentId: created.revision.contentId,
    };
    expect(await ContentService.getRevisionStatus(actor, input)).toEqual({
      id: created.revision.id,
      version: 1,
      state: "privacy_erased",
    });
    await expect(ContentService.getRevision(actor, input)).rejects.toThrow(
      "revision_erased",
    );
  });
  it("rejects a source erased between validation and atomic save", async () => {
    const source = await ContentSourceService.capture(actor, {
      projectId: "project",
      mutationId: "source",
      source: {
        kind: "pasted",
        title: "Owner",
        attribution: "Owner",
        text: "Evidence",
        publisherDate: null,
        language: null,
        market: null,
      },
    });
    const created = await ContentService.createBrief(actor, create);
    if (!created.ok) throw new Error("create failed");
    testDb.beforeNextBatch(async () => {
      await testDb.execute(
        `update content_sources set extraction_status = 'erased' where id = '${source.source.id}'`,
      );
    });
    await expect(
      ContentService.saveRevision(actor, {
        projectId: "project",
        contentId: created.revision.contentId,
        mutationId: "save",
        expectedHeadVersion: 1,
        expectedContextVersion: created.revision.contextVersion,
        brief,
        markdown: "Evidence",
        metadata,
        sourceIds: [source.source.id],
        claims: [],
        openQuestions: [],
        omissions: [],
      }),
    ).rejects.toThrow("source_unavailable");
    expect(
      await testDb.execute("select id from content_revisions"),
    ).toHaveLength(1);
  });
  it("creates a manual brief without a network request", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    try {
      await ContentService.createBrief(actor, create);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  it("saves an immutable body and replays a mutation after a later save", async () => {
    const created = await ContentService.createBrief(actor, create);
    if (!created.ok) throw new Error("create failed");
    const draft = {
      projectId: "project",
      contentId: created.revision.contentId,
      mutationId: "save-1",
      expectedHeadVersion: 1,
      expectedContextVersion: created.revision.contextVersion,
      brief,
      markdown: "ሰላም 😀",
      metadata,
      sourceIds: [],
      claims: [],
      openQuestions: [],
      omissions: [],
    };
    const saved = await ContentService.saveRevision(actor, draft);
    if (!saved.ok) throw new Error("save failed");
    const next = await ContentService.saveRevision(actor, {
      ...draft,
      mutationId: "save-2",
      expectedHeadVersion: 2,
      markdown: "Updated",
    });
    expect(next.ok).toBe(true);
    const replay = await ContentService.saveRevision(actor, draft);
    expect(replay).toEqual(saved);
    const read = await ContentService.getRevision(actor, {
      projectId: "project",
      contentId: draft.contentId,
      revisionId: saved.revision.id,
    });
    expect(read.revision.markdown).toBe("ሰላም 😀");
    expect(read.currentContextVersion).toBe(saved.revision.contextVersion);
    const archive = {
      projectId: "project",
      contentId: draft.contentId,
      mutationId: "archive",
      expectedHeadVersion: 3,
    };
    expect((await ContentService.archive(actor, archive)).replayed).toBe(false);
    expect((await ContentService.archive(actor, archive)).replayed).toBe(true);
    expect(
      (
        await ContentService.getRevision(actor, {
          projectId: "project",
          contentId: draft.contentId,
          revisionId: saved.revision.id,
        })
      ).revision.markdown,
    ).toBe("ሰላም 😀");
  });
  it("preserves the draft on competing saves and exposes live context after a change", async () => {
    const created = await ContentService.createBrief(actor, create);
    if (!created.ok) throw new Error("create failed");
    const draft = {
      projectId: "project",
      contentId: created.revision.contentId,
      expectedHeadVersion: 1,
      expectedContextVersion: created.revision.contextVersion,
      brief,
      markdown: "draft",
      metadata,
      sourceIds: [],
      claims: [],
      openQuestions: [],
      omissions: [],
    };
    const attempts = await Promise.all([
      ContentService.saveRevision(actor, { ...draft, mutationId: "one" }),
      ContentService.saveRevision(actor, { ...draft, mutationId: "two" }),
    ]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(attempts.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "revision_conflict", currentHeadVersion: 2 },
    ]);
    await applyContextUpdates(
      "project",
      [{ section: "current_goal", content: "New goal" }],
      "user",
    );
    const read = await ContentService.getRevision(actor, {
      projectId: "project",
      contentId: draft.contentId,
    });
    expect(read.currentContextVersion).toBeGreaterThan(
      read.revision.contextVersion,
    );
    expect(read.currentContextSnapshot.sections).toContainEqual(
      expect.objectContaining({ key: "current_goal", content: "New goal" }),
    );
    await expect(
      ContentService.saveRevision(actor, {
        ...draft,
        mutationId: "stale-context",
        expectedHeadVersion: 2,
      }),
    ).rejects.toThrow("context_changed");
  });
  it("links a claim to an exact typed audit observation", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    await testDb.executeMultiple(`
      INSERT INTO audits (id, project_id, started_by_user_id, start_url) VALUES ('audit', 'project', 'user', 'https://example.com');
      INSERT INTO audit_pages (id, audit_id, url) VALUES ('page', 'audit', 'https://example.com/page');
      INSERT INTO audit_issues (id, audit_id, page_id, page_url, issue_type) VALUES ('issue', 'audit', 'page', 'https://example.com/page', 'missing_title');
    `);
    const source = await ContentSourceService.capture(actor, {
      projectId: "project",
      mutationId: "audit-source",
      source: {
        kind: "audit",
        auditId: "audit",
        pageId: null,
        issueId: "issue",
      },
    });
    const created = await ContentService.createBrief(actor, create);
    if (!created.ok) throw new Error("create failed");
    const excerpt = '"issueType":"missing_title"';
    const start = source.source.sourceText.indexOf(excerpt);
    expect(start).toBeGreaterThanOrEqual(0);
    const saved = await ContentService.saveRevision(actor, {
      projectId: "project",
      contentId: created.revision.contentId,
      mutationId: "observed",
      expectedHeadVersion: 1,
      expectedContextVersion: created.revision.contextVersion,
      brief,
      markdown: "The audit found a missing title.",
      metadata,
      sourceIds: [source.source.id],
      claims: [
        {
          target: { kind: "markdown", start: 0, end: 32 },
          text: "The audit found a missing title.",
          kind: "general",
          factual: true,
          evidence: [
            {
              sourceId: source.source.id,
              start,
              end: start + excerpt.length,
              excerpt,
              relation: "supports",
            },
          ],
        },
      ],
      openQuestions: [],
      omissions: [],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("save failed");
    expect(saved.revision.claims[0].evidence[0].excerpt).toBe(excerpt);
    const read = await ContentService.getRevision(actor, {
      projectId: "project",
      contentId: saved.revision.contentId,
    });
    expect(read.sources[0]).toMatchObject({
      state: "available",
      source: { extractionMethod: "typed_audit_observation" },
    });
    const requested = await ContentReviewService.request(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      mutationId: "audit-review",
      expectedHeadVersion: 2,
      expectedContextVersion: read.revision.contextVersion,
      checkSetId: read.checks.id,
      assigneeUserId: "user",
    });
    await ContentReviewService.decide(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      requestId: requested.id,
      mutationId: "audit-approve",
      expectedRequestVersion: 0,
      expectedHeadVersion: 2,
      decision: "approve",
      claimAssessments: [
        {
          claimId: read.revision.claims[0].id,
          assessment: "supported",
          reason: "Observed",
        },
      ],
      assessedRemainingText: true,
      reason: "Reviewed",
    });
    await ContentExportService.exportRevision(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      format: "json",
    });
    expect(network).not.toHaveBeenCalled();
    await expect(
      ContentService.saveRevision(actor, {
        projectId: "project",
        contentId: saved.revision.contentId,
        mutationId: "audit-product",
        expectedHeadVersion: 2,
        expectedContextVersion: saved.revision.contextVersion,
        brief,
        markdown: "The audit found a missing title.",
        metadata,
        sourceIds: [source.source.id],
        claims: [
          {
            target: { kind: "markdown", start: 0, end: 32 },
            text: "The audit found a missing title.",
            kind: "product",
            factual: true,
            evidence: [
              {
                sourceId: source.source.id,
                start,
                end: start + excerpt.length,
                excerpt,
                relation: "supports",
              },
            ],
          },
        ],
        openQuestions: [],
        omissions: [],
      }),
    ).rejects.toThrow("audit_observation_not_sensitive_claim_support");
    await testDb.execute("delete from audits where id = 'audit'");
    const afterDeletion = await ContentService.getRevision(actor, {
      projectId: "project",
      contentId: saved.revision.contentId,
    });
    expect(afterDeletion.sources).toEqual([
      { sourceId: source.source.id, state: "unavailable", source: null },
    ]);
    expect(
      await ContentReviewService.currentEligibility(actor, {
        projectId: "project",
        contentId: read.revision.contentId,
        revisionId: read.revision.id,
        expectedHeadVersion: 2,
      }),
    ).toEqual({ eligible: false, reason: "source_unavailable" });
  });
});
