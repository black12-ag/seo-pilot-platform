import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// The migration-applied fixture must exist before static repository imports.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider, AUTH_MODE: "cloudflare_access" },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => true,
}));
import { ContentService } from "./ContentService";
import { ContentReviewService } from "./ContentReviewService";
import { ContentSourceService } from "./ContentSourceService";
import { applyContextUpdates } from "@/server/features/project-context/services/ProjectContextService";
import { WorkspaceMergeService } from "@/server/auth/workspace-merge";
import type { ContentActor } from "@/types/schemas/content";

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
beforeEach(testDb.seedProject);
afterAll(testDb.close);

async function approvedBrief(
  currentActor: ContentActor = actor,
  projectId = "project",
) {
  const created = await ContentService.createBrief(currentActor, {
    projectId,
    mutationId: "create",
    expectedHeadVersion: 0,
    brief,
  });
  if (!created.ok) throw new Error("create failed");
  const read = await ContentService.getRevision(currentActor, {
    projectId,
    contentId: created.revision.contentId,
  });
  const requested = await ContentReviewService.request(currentActor, {
    projectId,
    contentId: read.revision.contentId,
    revisionId: read.revision.id,
    mutationId: "request",
    expectedHeadVersion: 1,
    expectedContextVersion: read.revision.contextVersion,
    checkSetId: read.checks.id,
    assigneeUserId: "user",
  });
  await ContentReviewService.decide(currentActor, {
    projectId,
    contentId: read.revision.contentId,
    requestId: requested.id,
    mutationId: "approve",
    expectedRequestVersion: 0,
    expectedHeadVersion: 1,
    decision: "approve",
    claimAssessments: [],
    assessedRemainingText: true,
    reason: "Reviewed",
  });
  return read;
}

describe("manual human review", () => {
  it("requests and approves the exact current revision and refuses machine decisions", async () => {
    const created = await ContentService.createBrief(actor, {
      projectId: "project",
      mutationId: "create",
      expectedHeadVersion: 0,
      brief,
    });
    if (!created.ok) throw new Error("create failed");
    const read = await ContentService.getRevision(actor, {
      projectId: "project",
      contentId: created.revision.contentId,
    });
    const requested = await ContentReviewService.request(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      mutationId: "request",
      expectedHeadVersion: 1,
      expectedContextVersion: read.revision.contextVersion,
      checkSetId: read.checks.id,
      assigneeUserId: "user",
    });
    const decision = {
      projectId: "project",
      contentId: read.revision.contentId,
      requestId: requested.id,
      mutationId: "approve",
      expectedRequestVersion: 0,
      expectedHeadVersion: 1,
      decision: "approve" as const,
      claimAssessments: [],
      assessedRemainingText: true,
      reason: "Reviewed",
    };
    await expect(
      ContentReviewService.decide({ ...actor, surface: "mcp" }, decision),
    ).rejects.toThrow();
    const approved = await ContentReviewService.decide(actor, decision);
    expect(approved.state).toBe("approved");
    expect(approved.events[0]).toMatchObject({
      reviewerUserId: "user",
      reviewerMembershipId: "membership",
      decision: "approve",
      surface: "web",
    });
    const publication = {
      projectId: "project",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      expectedHeadVersion: 1,
    };
    expect(
      await ContentReviewService.requirePublishableRevision(actor, publication),
    ).toMatchObject({
      revisionId: read.revision.id,
      review: { requestId: requested.id, eventId: approved.events[0].id },
    });
    await testDb.execute(
      "update member set role = 'member' where id = 'membership'",
    );
    expect(
      await ContentReviewService.currentEligibility(actor, publication),
    ).toEqual({ eligible: false, reason: "reviewer_permission_lost" });
    await testDb.execute(
      "update member set role = 'owner' where id = 'membership'",
    );
    const withdrawn = await ContentReviewService.withdraw(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      requestId: requested.id,
      mutationId: "withdraw",
      expectedRequestVersion: 1,
      expectedHeadVersion: 1,
      reason: "Reconsidering",
    });
    expect(withdrawn.state).toBe("withdrawn");
    expect(withdrawn.events.map((event) => event.decision)).toEqual([
      "approve",
      "withdraw",
    ]);
    expect(await ContentReviewService.decide(actor, decision)).toEqual(
      approved,
    );
    expect(
      await ContentReviewService.request(actor, {
        projectId: "project",
        contentId: read.revision.contentId,
        revisionId: read.revision.id,
        mutationId: "request",
        expectedHeadVersion: 1,
        expectedContextVersion: read.revision.contextVersion,
        checkSetId: read.checks.id,
        assigneeUserId: "user",
      }),
    ).toEqual(requested);
    expect(
      await ContentReviewService.currentEligibility(actor, publication),
    ).toEqual({ eligible: false, reason: "approval_withdrawn" });
  });
  it("does not revive an approval when its reviewer leaves and rejoins", async () => {
    const read = await approvedBrief();
    const timestamp = testDb.provider === "postgres" ? "now()" : "0";
    await testDb.executeMultiple(`
      INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ('other','Other','other@example.com',${timestamp},${timestamp});
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('other-member','organization','other','owner',${timestamp});
      DELETE FROM member WHERE id = 'membership';
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('new-membership','organization','user','owner',${timestamp});
    `);
    const other = { ...actor, userId: "other" };
    expect(
      await ContentReviewService.currentEligibility(other, {
        projectId: "project",
        contentId: read.revision.contentId,
        revisionId: read.revision.id,
        expectedHeadVersion: 1,
      }),
    ).toEqual({ eligible: false, reason: "reviewer_removed" });
  });
  it("invalidates eligibility on context change, a new head and archive", async () => {
    const read = await approvedBrief();
    const publication = {
      projectId: "project",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      expectedHeadVersion: 1,
    };
    await applyContextUpdates(
      "project",
      [{ section: "current_goal", content: "Changed" }],
      "user",
    );
    expect(
      await ContentReviewService.currentEligibility(actor, publication),
    ).toEqual({ eligible: false, reason: "context_changed" });
    const live = await ContentService.getRevision(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
    });
    const saved = await ContentService.saveRevision(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      mutationId: "new-head",
      expectedHeadVersion: 1,
      expectedContextVersion: live.currentContextVersion,
      brief,
      markdown: "new",
      metadata: { title: "", slug: "", description: "", schemaSuggestion: "" },
      sourceIds: [],
      claims: [],
      openQuestions: [],
      omissions: [],
    });
    expect(saved.ok).toBe(true);
    expect(
      await ContentReviewService.currentEligibility(actor, publication),
    ).toEqual({ eligible: false, reason: "head_changed" });
    await ContentService.archive(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      mutationId: "archive",
      expectedHeadVersion: 2,
    });
    expect(
      await ContentReviewService.currentEligibility(actor, publication),
    ).toEqual({ eligible: false, reason: "content_archived" });
  });
  it("does not revive approval after an actual workspace transfer and context restoration", async () => {
    const timestamp = testDb.provider === "postgres" ? "now()" : "0";
    await testDb.executeMultiple(`
      INSERT INTO organization (id,name,slug,created_at) VALUES ('delegated-old','Old workspace','delegated-old',${timestamp}),('shared-workspace','Shared','shared-workspace',${timestamp});
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('old-member','delegated-old','user','owner',${timestamp}),('shared-member','shared-workspace','user','owner',${timestamp});
      INSERT INTO projects (id,organization_id,name,domain) VALUES ('transferred','delegated-old','Transfer','transfer.example');
    `);
    const oldActor = { ...actor, organizationId: "delegated-old" };
    const read = await approvedBrief(oldActor, "transferred");
    await WorkspaceMergeService.mergeLegacyWorkspaces();
    const publication = {
      projectId: "transferred",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      expectedHeadVersion: 1,
    };
    await expect(
      ContentReviewService.currentEligibility(oldActor, publication),
    ).rejects.toThrow();
    const newActor = { ...actor, organizationId: "shared-workspace" };
    expect(
      await ContentReviewService.currentEligibility(newActor, publication),
    ).toEqual({ eligible: false, reason: "reviewer_removed" });
    await applyContextUpdates(
      "transferred",
      [{ section: "current_goal", content: "Temporary" }],
      "user",
    );
    await applyContextUpdates(
      "transferred",
      [{ section: "current_goal", content: "" }],
      "user",
    );
    expect(
      await ContentReviewService.currentEligibility(newActor, publication),
    ).toEqual({ eligible: false, reason: "reviewer_removed" });
  });
  it("rejects approval when sensitive supporting evidence is stale", async () => {
    const source = await ContentSourceService.capture(actor, {
      projectId: "project",
      mutationId: "source",
      source: {
        kind: "pasted",
        title: "Owner",
        attribution: "Owner",
        text: "Price is 10",
        publisherDate: null,
        language: null,
        market: null,
      },
    });
    const created = await ContentService.createBrief(actor, {
      projectId: "project",
      mutationId: "create",
      expectedHeadVersion: 0,
      brief,
    });
    if (!created.ok) throw new Error("create failed");
    const saved = await ContentService.saveRevision(actor, {
      projectId: "project",
      contentId: created.revision.contentId,
      mutationId: "save",
      expectedHeadVersion: 1,
      expectedContextVersion: created.revision.contextVersion,
      brief,
      markdown: "Price is 10",
      metadata: { title: "", slug: "", description: "", schemaSuggestion: "" },
      sourceIds: [source.source.id],
      claims: [
        {
          target: { kind: "markdown", start: 0, end: 11 },
          text: "Price is 10",
          kind: "financial",
          factual: true,
          evidence: [
            {
              sourceId: source.source.id,
              start: 0,
              end: 11,
              excerpt: "Price is 10",
              relation: "supports",
            },
          ],
        },
      ],
      openQuestions: [],
      omissions: [],
    });
    if (!saved.ok) throw new Error("save failed");
    const read = await ContentService.getRevision(actor, {
      projectId: "project",
      contentId: saved.revision.contentId,
    });
    const requested = await ContentReviewService.request(actor, {
      projectId: "project",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      mutationId: "request",
      expectedHeadVersion: 2,
      expectedContextVersion: read.revision.contextVersion,
      checkSetId: read.checks.id,
      assigneeUserId: "user",
    });
    const decision = {
      projectId: "project",
      contentId: read.revision.contentId,
      requestId: requested.id,
      mutationId: "approve",
      expectedRequestVersion: 0,
      expectedHeadVersion: 2,
      decision: "approve" as const,
      claimAssessments: [
        {
          claimId: read.revision.claims[0].id,
          assessment: "supported" as const,
          reason: "Reviewed",
        },
      ],
      assessedRemainingText: true,
      reason: "Reviewed",
    };
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(source.source.capturedAtMs + 8 * 86_400_000);
    try {
      await expect(
        ContentReviewService.decide(actor, decision),
      ).rejects.toThrow("source_stale");
    } finally {
      clock.mockRestore();
    }
    await ContentReviewService.decide(actor, decision);
    const later = vi
      .spyOn(Date, "now")
      .mockReturnValue(source.source.capturedAtMs + 8 * 86_400_000);
    try {
      expect(
        await ContentReviewService.currentEligibility(actor, {
          projectId: "project",
          contentId: read.revision.contentId,
          revisionId: read.revision.id,
          expectedHeadVersion: 2,
        }),
      ).toEqual({ eligible: false, reason: "source_stale" });
    } finally {
      later.mockRestore();
    }
  });
});
