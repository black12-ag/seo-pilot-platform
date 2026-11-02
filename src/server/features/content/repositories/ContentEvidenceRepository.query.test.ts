import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { ContentEvidenceRepository } from "./ContentEvidenceRepository";
import type {
  ContentWriteScope,
  PreparedSourceWrite,
} from "./contentRevisionWrites";

const scope: ContentWriteScope = {
  actor: {
    organizationId: "organization",
    userId: "user",
    role: "owner",
    surface: "web",
  },
  membershipId: "membership",
};
const capture: PreparedSourceWrite = {
  mutationId: "capture",
  requestHash: "hash",
  source: {
    id: "source",
    projectId: "project",
    kind: "pasted",
    title: "Source",
    attribution: "Owner",
    sourceText: "Text",
    textHash: "text-hash",
    capturedAtMs: 1,
    publisherDate: null,
    language: null,
    market: null,
    extractionMethod: "pasted",
    extractionVersion: "1",
    extractionStatus: "usable",
    extractionReason: null,
    auditReference: null,
  },
};

beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe(`content evidence (${testDb.provider})`, () => {
  it("captures once, replays the exact receipt, and rejects changed request hashes", async () => {
    expect(
      await ContentEvidenceRepository.captureSource(scope, capture),
    ).toEqual({ ok: true, resultId: "source", replayed: false });
    expect(
      await ContentEvidenceRepository.captureSource(scope, {
        ...capture,
        source: { ...capture.source, id: "other" },
      }),
    ).toEqual({ ok: true, resultId: "source", replayed: true });
    expect(
      await ContentEvidenceRepository.captureSource(scope, {
        ...capture,
        requestHash: "changed",
      }),
    ).toEqual({ ok: false, code: "conflict" });
    expect(await testDb.execute("select id from content_sources")).toHaveLength(
      1,
    );
  });

  it("rolls back receipt and source if membership vanishes mid-batch", async () => {
    testDb.mutateMembershipInNextBatchAt(3, null);
    await expect(
      ContentEvidenceRepository.captureSource(scope, capture),
    ).rejects.toThrow();
    expect(
      await testDb.execute("select id from content_mutations"),
    ).toHaveLength(0);
    expect(await testDb.execute("select id from content_sources")).toHaveLength(
      0,
    );
  });

  it("captures a scoped audit and rejects a foreign audit before admission", async () => {
    await testDb.executeMultiple(`
      INSERT INTO audits (id, project_id, started_by_user_id, start_url) VALUES
      ('audit', 'project', 'user', 'https://example.com'),
      ('foreign-audit', 'foreign-project', 'user', 'https://other.com');
      INSERT INTO audit_pages (id, audit_id, url) VALUES ('page', 'audit', 'https://example.com/page');
      INSERT INTO audit_issues (id, audit_id, page_id, page_url, issue_type) VALUES ('issue', 'audit', 'page', 'https://example.com/page', 'missing_title');
    `);
    expect(
      await ContentEvidenceRepository.getAuditObservation(
        "foreign",
        "project",
        { kind: "audit", auditId: "audit", pageId: "page", issueId: "issue" },
      ),
    ).toBeNull();
    expect(
      await ContentEvidenceRepository.getAuditObservation(
        "organization",
        "project",
        { kind: "audit", auditId: "audit", pageId: null, issueId: "issue" },
      ),
    ).toMatchObject({ page: { id: "page" }, issue: { id: "issue" } });
    expect(
      await ContentEvidenceRepository.getAuditObservation(
        "organization",
        "project",
        { kind: "audit", auditId: "audit", pageId: "page", issueId: "issue" },
      ),
    ).toMatchObject({
      audit: { id: "audit" },
      page: { id: "page" },
      issue: { id: "issue", issueType: "missing_title" },
    });
    const audit = {
      ...capture,
      source: {
        ...capture.source,
        kind: "audit" as const,
        auditReference: { auditId: "audit", pageId: null, issueId: null },
      },
    };
    expect(
      await ContentEvidenceRepository.captureSource(scope, {
        ...audit,
        source: {
          ...audit.source,
          auditReference: {
            auditId: "foreign-audit",
            pageId: null,
            issueId: null,
          },
        },
      }),
    ).toEqual({ ok: false, code: "conflict" });
    expect(await ContentEvidenceRepository.captureSource(scope, audit)).toEqual(
      { ok: true, resultId: "source", replayed: false },
    );
  });
  it("scopes captured audit evidence and keeps text when its audit is removed", async () => {
    await testDb.executeMultiple(`
      INSERT INTO audits (id, project_id, started_by_user_id, start_url) VALUES ('audit', 'project', 'user', 'https://example.com');
      INSERT INTO content_mutations (id, project_id, mutation_id, request_hash, kind, result_id, completed, created_at_ms) VALUES ('receipt', 'project', 'capture', 'hash', 'capture', 'source', 1, 1);
      INSERT INTO content_sources (id, project_id, mutation_receipt_id, kind, title, attribution, source_text, text_hash, captured_at_ms, extraction_method, extraction_version, extraction_status)
      VALUES ('source', 'project', 'receipt', 'audit', 'Audit', 'Audit', 'captured', 'hash', 1, 'audit', '1', 'usable');
      INSERT INTO content_source_audit_references (source_id, project_id, audit_id) VALUES ('source', 'project', 'audit');
    `);
    expect(
      await ContentEvidenceRepository.getSource("foreign", "project", "source"),
    ).toBeNull();
    expect(
      (
        await ContentEvidenceRepository.getSource(
          "organization",
          "project",
          "source",
        )
      )?.auditReference?.auditId,
    ).toBe("audit");
    await testDb.execute("DELETE FROM audits WHERE id = 'audit'");
    expect(
      await ContentEvidenceRepository.getSource(
        "organization",
        "project",
        "source",
      ),
    ).toMatchObject({
      source: { sourceText: "captured" },
      auditReference: null,
    });
  });

  it("rejects a source reference to a different project's audit", async () => {
    await testDb.executeMultiple(`
      INSERT INTO audits (id, project_id, started_by_user_id, start_url) VALUES ('foreign-audit', 'foreign-project', 'user', 'https://other.com');
      INSERT INTO content_mutations (id, project_id, mutation_id, request_hash, kind, result_id, completed, created_at_ms) VALUES ('receipt', 'project', 'capture', 'hash', 'capture', 'source', 1, 1);
      INSERT INTO content_sources (id, project_id, mutation_receipt_id, kind, title, attribution, source_text, text_hash, captured_at_ms, extraction_method, extraction_version, extraction_status)
      VALUES ('source', 'project', 'receipt', 'audit', 'Audit', 'Audit', 'captured', 'hash', 1, 'audit', '1', 'usable');
    `);
    await expect(
      testDb.execute(
        "INSERT INTO content_source_audit_references (source_id, project_id, audit_id) VALUES ('source', 'project', 'foreign-audit')",
      ),
    ).rejects.toThrow();
  });
});
