import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";

const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../src/server/features/site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import { ContentRepository } from "../../src/server/features/content/repositories/ContentRepository";
import { ContentEvidenceRepository } from "../../src/server/features/content/repositories/ContentEvidenceRepository";
import {
  contentTestScope as scope,
  contentTestWrite as write,
} from "../../src/server/features/content/contentTestDb";
import { erasePostgres, verifyPostgres } from "./postgres";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe.skipIf(testDb.provider !== "postgres")(
  "retained workspace content erasure",
  () => {
    it("rolls back redaction when an organization gains another member", async () => {
      if (!testDb.pg) throw new Error("PostgreSQL fixture required");
      await ContentEvidenceRepository.captureSource(scope, {
        mutationId: "capture",
        requestHash: "capture-hash",
        source: {
          id: "source",
          projectId: "project",
          kind: "pasted",
          title: "Private",
          attribution: "Owner",
          sourceText: "Private proof",
          textHash: "source-hash",
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
      });
      await testDb.executeMultiple(`
        INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ('other','Other','other@example.com',now(),now());
        INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('other-member','organization','other','member',now());
      `);
      await expect(
        erasePostgres(
          drizzle(testDb.pg),
          { id: "user", email: "authority@example.com", name: "User" },
          ["organization"],
        ),
      ).rejects.toThrow("gained other members");
      expect(
        await testDb.execute(
          "select source_text, extraction_status from content_sources where id = 'source'",
        ),
      ).toMatchObject([
        { source_text: "Private proof", extraction_status: "usable" },
      ]);
      expect(
        await testDb.execute("select id from \"user\" where id = 'user'"),
      ).toHaveLength(1);
    });
    it("redacts authored and reused-source history but preserves unrelated content", async () => {
      if (!testDb.pg) throw new Error("PostgreSQL fixture required");
      await testDb.executeMultiple(`
      INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ('other','Other','other@example.com',now(),now());
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('other-member','organization','other','owner',now());
    `);
      await ContentEvidenceRepository.captureSource(scope, {
        mutationId: "capture",
        requestHash: "capture-hash",
        source: {
          id: "source",
          projectId: "project",
          kind: "pasted",
          title: "Private title",
          attribution: "Private owner",
          sourceText: "Private proof",
          textHash: "source-hash",
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
      });
      await testDb.executeMultiple(`
        UPDATE content_sources SET kind = 'web' WHERE id = 'source';
        INSERT INTO content_source_url_captures VALUES ('source','project','https://example.com/private','https://example.com/private',200,0,1,1,0,13);
      `);
      const claim = {
        id: "claim-1",
        target: { kind: "markdown" as const, start: 0, end: 4 },
        text: "Body",
        textHash: "text-hash",
        kind: "general" as const,
        factual: true,
        evidence: [
          {
            id: "evidence-1",
            sourceId: "source",
            start: 0,
            end: 7,
            excerpt: "Private",
            excerptHash: "excerpt-hash",
            passageId: "passage",
            relation: "supports" as const,
          },
        ],
      };
      await ContentRepository.createRevision(scope, {
        ...write,
        sourceHashes: [{ sourceId: "source", textHash: "source-hash" }],
        revision: { ...write.revision, sourceIds: ["source"], claims: [claim] },
      });
      const other = {
        actor: { ...scope.actor, userId: "other" },
        membershipId: "other-member",
      };
      await ContentRepository.saveRevision(other, {
        ...write,
        mutationId: "save",
        expectedHeadVersion: 1,
        sourceHashes: [{ sourceId: "source", textHash: "source-hash" }],
        revision: {
          ...write.revision,
          id: "revision-2",
          version: 2,
          parentRevisionId: "revision",
          sourceIds: ["source"],
          claims: [
            {
              ...claim,
              id: "claim-2",
              evidence: [{ ...claim.evidence[0], id: "evidence-2" }],
            },
          ],
        },
        checkSet: { ...write.checkSet, id: "checks-2" },
      });
      await ContentRepository.createRevision(other, {
        ...write,
        mutationId: "unaffected",
        revision: {
          ...write.revision,
          id: "unaffected-revision",
          contentId: "unaffected",
        },
        checkSet: { ...write.checkSet, id: "unaffected-checks" },
      });
      await testDb.executeMultiple(`
      INSERT INTO content_mutations (id,project_id,mutation_id,request_hash,kind,result_id,completed,created_at_ms) VALUES ('review-receipt','project','review','hash','review','request',1,1),('event-receipt','project','event','hash','decision','event',1,1);
      INSERT INTO content_review_requests (id,project_id,content_id,revision_id,check_set_id,mutation_receipt_id,assignee_user_id,requested_by_user_id,version,state,context_version,created_at_ms,sequence) VALUES ('request','project','content','revision-2','checks-2','review-receipt','other','other',1,'approved',0,1,1);
      INSERT INTO content_review_events (id,project_id,content_id,revision_id,request_id,mutation_receipt_id,reviewer_user_id,reviewer_membership_id,decision,surface,reason,assessed_remaining_text,created_at_ms,request_version) VALUES ('event','project','content','revision-2','request','event-receipt','user','membership','approve','web','Private reason',1,1,1);
      INSERT INTO content_claim_assessments (id,project_id,content_id,revision_id,event_id,claim_id,assessment,reason) VALUES ('assessment','project','content','revision-2','event','claim-2','supported','Private assessment');
      DELETE FROM member WHERE id = 'membership';
    `);
      const db = drizzle(testDb.pg);
      const receipt = await erasePostgres(
        db,
        { id: "user", email: "authority@example.com", name: "User" },
        [],
      );
      await verifyPostgres(db, "user", [], receipt);
      expect(
        await ContentRepository.getRevision(
          "organization",
          "project",
          "content",
          "revision",
        ),
      ).toBeNull();
      expect(
        await ContentRepository.getRevision(
          "organization",
          "project",
          "content",
          "revision-2",
        ),
      ).toBeNull();
      expect(
        await ContentRepository.getRevisionStatus(
          "organization",
          "project",
          "content",
          "revision-2",
        ),
      ).toMatchObject({ redactedAtMs: expect.any(Number) });
      expect(
        await ContentRepository.getRevisionStatus(
          "organization",
          "project",
          "content",
        ),
      ).toMatchObject({ id: "revision-2", redactedAtMs: expect.any(Number) });
      expect(
        await ContentRepository.list("organization", {
          projectId: "project",
          state: "privacy_erased",
        }),
      ).toMatchObject({
        items: [
          { id: "content", state: "privacy_erased", title: "", topic: "" },
        ],
      });
      expect(
        await ContentRepository.getRevision(
          "organization",
          "project",
          "unaffected",
        ),
      ).toMatchObject({ markdown: "Body" });
      expect(
        await ContentEvidenceRepository.getCheckSet(
          "organization",
          "project",
          "content",
          "revision-2",
          "checks-2",
        ),
      ).toBeNull();
      expect(
        await ContentEvidenceRepository.listSources(
          "organization",
          "project",
          {},
        ),
      ).toMatchObject({ items: [{ id: "source", available: false }] });
      expect(
        await testDb.execute(
          "select source_text, attribution, extraction_status from content_sources where id = 'source'",
        ),
      ).toMatchObject([
        { source_text: "", attribution: "", extraction_status: "erased" },
      ]);
      expect(
        await testDb.execute(
          "select source_id from content_source_url_captures",
        ),
      ).toHaveLength(0);
      expect(
        await testDb.execute("select text from content_claims order by id"),
      ).toMatchObject([{ text: "" }, { text: "" }]);
      expect(
        await testDb.execute(
          "select excerpt from content_claim_evidence order by id",
        ),
      ).toMatchObject([{ excerpt: "" }, { excerpt: "" }]);
      expect(
        await testDb.execute(
          "select reason from content_review_events where id = 'event'",
        ),
      ).toMatchObject([{ reason: "" }]);
      expect(
        await testDb.execute(
          "select request_hash from content_mutations where id in ('event-receipt')",
        ),
      ).toMatchObject([{ request_hash: "" }]);
    });
  },
);
