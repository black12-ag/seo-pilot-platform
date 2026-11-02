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
import { ContentRepository } from "./ContentRepository";
import { ContentReviewRepository } from "./ContentReviewRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  contentTestScope as scope,
  contentTestWrite as write,
} from "../contentTestDb";

beforeEach(testDb.seedProject);
afterAll(testDb.close);
const request = {
  input: {
    projectId: "project",
    contentId: "content",
    revisionId: "revision",
    mutationId: "request",
    expectedHeadVersion: 1,
    expectedContextVersion: 0,
    checkSetId: "checks",
    assigneeUserId: "user",
  },
  requestId: "request-id",
  requestHash: "request-hash",
  createdAtMs: 1,
};
const decision = {
  input: {
    projectId: "project",
    contentId: "content",
    requestId: "request-id",
    mutationId: "approve",
    expectedRequestVersion: 0,
    expectedHeadVersion: 1,
    decision: "approve" as const,
    claimAssessments: [],
    assessedRemainingText: true,
    reason: "",
  },
  eventId: "event-1",
  requestHash: "approve-hash",
  expectedContextVersion: 0,
  contextHash: "context",
  sourceSetHash: "sources",
  checkSetHash: "checks-hash",
  createdAtMs: 1,
};

describe(`content review persistence (${testDb.provider})`, () => {
  it("orders request, approval, withdrawal and a later request without clock ordering", async () => {
    await ContentRepository.createRevision(scope, write);
    expect(await ContentReviewRepository.requestReview(scope, request)).toEqual(
      { ok: true, resultId: "request-id", replayed: false },
    );
    expect(await ContentReviewRepository.requestReview(scope, request)).toEqual(
      { ok: true, resultId: "request-id", replayed: true },
    );
    expect(await ContentReviewRepository.decideReview(scope, decision)).toEqual(
      { ok: true, resultId: "event-1", replayed: false },
    );
    expect(await ContentReviewRepository.decideReview(scope, decision)).toEqual(
      { ok: true, resultId: "event-1", replayed: true },
    );
    expect(
      await ContentRepository.list("organization", {
        projectId: "project",
        state: "approved",
      }),
    ).toMatchObject({
      items: [
        { id: "content", title: "Title", topic: "Topic", state: "approved" },
      ],
    });
    expect(
      await ContentReviewRepository.withdrawApproval(scope, {
        ...decision,
        input: {
          projectId: "project",
          contentId: "content",
          requestId: "request-id",
          mutationId: "withdraw",
          expectedRequestVersion: 1,
          expectedHeadVersion: 1,
          reason: "",
        },
        eventId: "event-2",
        requestHash: "withdraw-hash",
      }),
    ).toEqual({ ok: true, resultId: "event-2", replayed: false });
    expect(
      await ContentReviewRepository.requestReview(scope, {
        ...request,
        input: { ...request.input, mutationId: "request-2" },
        requestId: "request-id-2",
        requestHash: "request-hash-2",
      }),
    ).toEqual({ ok: true, resultId: "request-id-2", replayed: false });
    expect(
      await ContentRepository.list("organization", { projectId: "project" }),
    ).toMatchObject({ items: [{ id: "content", state: "review_requested" }] });
    expect(
      await ContentRepository.getItemStatus(
        "organization",
        "project",
        "content",
      ),
    ).toMatchObject({ headVersion: 1, reviewVersion: 2, archivedAtMs: null });
    expect(
      await ContentReviewRepository.getReview(
        "organization",
        "project",
        "content",
      ),
    ).toMatchObject({
      id: "request-id-2",
      sequence: 2,
      version: 0,
      state: "pending",
      events: [],
    });
    expect(
      await ContentReviewRepository.getReview(
        "organization",
        "project",
        "content",
        "request-id",
      ),
    ).toMatchObject({
      sequence: 1,
      version: 2,
      state: "withdrawn",
      events: [
        { requestVersion: 1, decision: "approve" },
        { requestVersion: 2, decision: "withdraw" },
      ],
    });
  });

  it("rolls back a request after an injected transaction fault", async () => {
    await ContentRepository.createRevision(scope, write);
    testDb.failNextBatchAt(4);
    await expect(
      ContentReviewRepository.requestReview(scope, request),
    ).rejects.toThrow();
    expect(
      await testDb.execute("select id from content_review_requests"),
    ).toHaveLength(0);
    expect(
      await testDb.execute("select review_version from content_items"),
    ).toMatchObject([{ review_version: 0 }]);
  });

  it("rejects non-web, unattested and stale-context approvals", async () => {
    await ContentRepository.createRevision(scope, write);
    await ContentReviewRepository.requestReview(scope, request);
    expect(
      await ContentReviewRepository.decideReview(
        { ...scope, actor: { ...scope.actor, surface: "mcp" } },
        decision,
      ),
    ).toEqual({ ok: false, code: "conflict" });
    expect(
      await ContentReviewRepository.decideReview(scope, {
        ...decision,
        input: { ...decision.input, assessedRemainingText: false },
      }),
    ).toEqual({ ok: false, code: "conflict" });
    await ProjectRepository.updateProject("project", "organization", {
      name: "Changed",
      domain: "example.com",
    });
    expect(await ContentReviewRepository.decideReview(scope, decision)).toEqual(
      { ok: false, code: "conflict" },
    );
    expect(
      await testDb.execute("select id from content_review_events"),
    ).toHaveLength(0);
  });

  it("does not revive approval when its reviewer leaves and rejoins", async () => {
    await ContentRepository.createRevision(scope, write);
    await ContentReviewRepository.requestReview(scope, request);
    await ContentReviewRepository.decideReview(scope, decision);
    await testDb.execute("DELETE FROM member WHERE id = 'membership'");
    await testDb.execute(
      `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('new-membership', 'organization', 'user', 'owner', ${testDb.provider === "postgres" ? "now()" : "0"})`,
    );
    expect(
      await ContentReviewRepository.getReview(
        "organization",
        "project",
        "content",
      ),
    ).toMatchObject({ events: [{ reviewerMembershipId: null }] });
    expect(await ContentReviewRepository.decideReview(scope, decision)).toEqual(
      { ok: false, code: "conflict" },
    );
  });

  it("rolls back an admitted decision if membership disappears mid-batch", async () => {
    await ContentRepository.createRevision(scope, write);
    await ContentReviewRepository.requestReview(scope, request);
    testDb.mutateMembershipInNextBatchAt(7, null);
    await expect(
      ContentReviewRepository.decideReview(scope, decision),
    ).rejects.toThrow();
    expect(
      await testDb.execute("select id from content_review_events"),
    ).toHaveLength(0);
    expect(
      await testDb.execute(
        "select id from content_mutations where mutation_id = 'approve'",
      ),
    ).toHaveLength(0);
  });

  it("refuses an unsupported sensitive claim even with a favorable assessment", async () => {
    const claim = {
      id: "claim",
      target: { kind: "markdown" as const, start: 0, end: 4 },
      text: "Body",
      textHash: "hash",
      kind: "security" as const,
      factual: true,
      evidence: [],
    };
    await ContentRepository.createRevision(scope, {
      ...write,
      revision: { ...write.revision, claims: [claim] },
    });
    await ContentReviewRepository.requestReview(scope, request);
    expect(
      await ContentReviewRepository.decideReview(scope, {
        ...decision,
        input: {
          ...decision.input,
          claimAssessments: [
            { claimId: "claim", assessment: "supported", reason: "" },
          ],
        },
      }),
    ).toEqual({ ok: false, code: "conflict" });
    expect(
      await testDb.execute("select id from content_review_events"),
    ).toHaveLength(0);
  });

  it("finds the latest review for the selected historical revision", async () => {
    await ContentRepository.createRevision(scope, write);
    await ContentReviewRepository.requestReview(scope, request);
    await ContentReviewRepository.decideReview(scope, decision);
    await ContentRepository.saveRevision(scope, {
      ...write,
      mutationId: "save",
      expectedHeadVersion: 1,
      revision: {
        ...write.revision,
        id: "revision-2",
        version: 2,
        parentRevisionId: "revision",
      },
      checkSet: { ...write.checkSet, id: "checks-2" },
    });
    await ContentReviewRepository.requestReview(scope, {
      ...request,
      input: {
        ...request.input,
        mutationId: "request-2",
        revisionId: "revision-2",
        expectedHeadVersion: 2,
        checkSetId: "checks-2",
      },
      requestId: "request-id-2",
      requestHash: "request-hash-2",
    });
    expect(
      await ContentReviewRepository.getReviewForRevision(
        "organization",
        "project",
        "content",
        "revision",
      ),
    ).toMatchObject({ id: "request-id", state: "approved" });
    expect(
      await ContentReviewRepository.getReviewForRevision(
        "organization",
        "project",
        "content",
        "revision-2",
      ),
    ).toMatchObject({ id: "request-id-2", state: "pending" });
    expect(
      await ContentReviewRepository.getReviewForRevision(
        "foreign",
        "project",
        "content",
        "revision",
      ),
    ).toBeNull();
  });

  it("never binds an old approval to a concurrently saved head", async () => {
    await ContentRepository.createRevision(scope, write);
    await ContentReviewRepository.requestReview(scope, request);
    const save = {
      ...write,
      mutationId: "save",
      expectedHeadVersion: 1,
      revision: {
        ...write.revision,
        id: "revision-2",
        version: 2,
        parentRevisionId: "revision",
      },
      checkSet: { ...write.checkSet, id: "checks-2" },
    };
    const [reviewResult, saveResult] = await Promise.all([
      ContentReviewRepository.decideReview(scope, decision),
      ContentRepository.saveRevision(scope, save),
    ]);
    expect(saveResult.ok).toBe(true);
    expect(reviewResult.ok || reviewResult.code === "conflict").toBe(true);
    expect(
      await ContentRepository.getItemStatus(
        "organization",
        "project",
        "content",
      ),
    ).toMatchObject({ headVersion: 2 });
    expect(
      await ContentReviewRepository.getReview(
        "organization",
        "project",
        "content",
      ),
    ).toMatchObject({ revisionId: "revision" });
    expect(
      (
        await testDb.execute("select revision_id from content_review_events")
      ).every((event) => event.revision_id === "revision"),
    ).toBe(true);
  });

  it("does not revive review after domain changes away and back", async () => {
    await ContentRepository.createRevision(scope, write);
    await ContentReviewRepository.requestReview(scope, request);
    await ProjectRepository.updateProject("project", "organization", {
      name: "Project",
      domain: "other.example",
    });
    await ProjectRepository.updateProject("project", "organization", {
      name: "Project",
      domain: "example.com",
    });
    expect(await ContentReviewRepository.decideReview(scope, decision)).toEqual(
      { ok: false, code: "conflict" },
    );
    expect(
      await testDb.execute("select id from content_review_events"),
    ).toHaveLength(0);
  });
});
