import { createHash } from "node:crypto";
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
import {
  contentTestScope as scope,
  contentTestWrite as write,
} from "../contentTestDb";
import { ContentEvidenceRepository } from "./ContentEvidenceRepository";
import { ContentRepository } from "./ContentRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { applyContextUpdates } from "@/server/features/project-context/services/ProjectContextService";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe(`content context lifecycle (${testDb.provider})`, () => {
  it("rejects a source changed between validation and revision admission", async () => {
    await ContentEvidenceRepository.captureSource(scope, {
      mutationId: "capture",
      requestHash: "capture-hash",
      source: {
        id: "source",
        projectId: "project",
        kind: "pasted",
        title: "Source",
        attribution: "Owner",
        sourceText: "Proof",
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
    testDb.beforeNextBatch(async () => {
      await testDb.execute(
        "UPDATE content_sources SET source_text = '', extraction_status = 'erased', text_hash = 'erased' WHERE id = 'source'",
      );
    });
    expect(
      await ContentRepository.createRevision(scope, {
        ...write,
        sourceHashes: [{ sourceId: "source", textHash: "source-hash" }],
        revision: { ...write.revision, sourceIds: ["source"] },
      }),
    ).toEqual({ ok: false, code: "revision_conflict" });
    expect(
      await testDb.execute("select id from content_revisions"),
    ).toHaveLength(0);
    expect(
      await testDb.execute(
        "select id from content_mutations where mutation_id = 'create'",
      ),
    ).toHaveLength(0);
  });
  it("fences context edits and project updates but not research log writes", async () => {
    const version = () =>
      ContentRepository.getContextVersion("organization", "project");
    expect(await version()).toBe(0);
    await applyContextUpdates(
      "project",
      [{ section: "current_goal", content: "Goal" }],
      "user",
    );
    expect(await version()).toBe(1);
    await applyContextUpdates(
      "project",
      [{ appendResearchLog: { summary: "Observation" } }],
      "user",
    );
    expect(await version()).toBe(1);
    await ProjectRepository.updateProject("project", "organization", {
      name: "Changed",
      domain: "example.com",
    });
    expect(await version()).toBe(2);
    await ProjectRepository.archiveProject("project", "organization");
    expect(await version()).toBeNull();
    await ProjectRepository.restoreProject("project", "organization");
    expect(await version()).toBe(4);
  });

  it("rolls the context fence back with a failed project transaction", async () => {
    testDb.failNextBatchAt(2);
    await expect(
      ProjectRepository.updateProject("project", "organization", {
        name: "Changed",
        domain: "example.com",
      }),
    ).rejects.toThrow();
    expect(
      await ContentRepository.getContextVersion("organization", "project"),
    ).toBe(0);
    expect(
      (
        await ProjectRepository.getProjectForOrganization(
          "project",
          "organization",
        )
      )?.name,
    ).toBe("Project");
  });
});

describe(`content evidence persistence (${testDb.provider})`, () => {
  it("reads claims, evidence and checks in stable ID order for portable hashes", async () => {
    await ContentEvidenceRepository.captureSource(scope, {
      mutationId: "capture",
      requestHash: "capture-hash",
      source: {
        id: "source",
        projectId: "project",
        kind: "pasted",
        title: "Source",
        attribution: "Owner",
        sourceText: "Zebra Apple",
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
    const claims = [
      {
        id: "claim-001",
        target: { kind: "markdown" as const, start: 0, end: 4 },
        text: "Zulu",
        textHash: "z",
        kind: "general" as const,
        factual: true,
        evidence: [
          {
            id: "evidence-001",
            sourceId: "source",
            start: 0,
            end: 5,
            excerpt: "Zebra",
            excerptHash: "z",
            passageId: "z",
            relation: "supports" as const,
          },
        ],
      },
      {
        id: "claim-002",
        target: { kind: "markdown" as const, start: 5, end: 10 },
        text: "Alpha",
        textHash: "a",
        kind: "general" as const,
        factual: true,
        evidence: [
          {
            id: "evidence-002",
            sourceId: "source",
            start: 6,
            end: 11,
            excerpt: "Apple",
            excerptHash: "a",
            passageId: "a",
            relation: "supports" as const,
          },
        ],
      },
    ];
    const checks = ["Zulu", "Alpha"].map((explanation, index) => ({
      id: `check-00${index + 1}`,
      claimId: claims[index].id,
      field: null,
      rule: "rule",
      status: "not_assessed",
      severity: "info",
      explanation,
    }));
    await ContentRepository.createRevision(scope, {
      ...write,
      sourceHashes: [{ sourceId: "source", textHash: "source-hash" }],
      revision: {
        ...write.revision,
        markdown: "Zulu Alpha",
        sourceIds: ["source"],
        claims: [claims[1], claims[0]],
      },
      checkSet: { ...write.checkSet, checks: [checks[1], checks[0]] },
    });
    const read = async () => ({
      revision: await ContentRepository.getRevision(
        "organization",
        "project",
        "content",
      ),
      checkSet: await ContentEvidenceRepository.getCheckSet(
        "organization",
        "project",
        "content",
        "revision",
        "checks",
      ),
    });
    const first = await read();
    expect(first.revision?.claims.map((claim) => claim.text)).toEqual([
      "Zulu",
      "Alpha",
    ]);
    expect(
      first.revision?.claims.map((claim) => claim.evidence[0].excerpt),
    ).toEqual(["Zebra", "Apple"]);
    expect(first.checkSet?.checks.map((check) => check.explanation)).toEqual([
      "Zulu",
      "Alpha",
    ]);
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(hash(await read())).toBe(hash(first));
  });

  it("round trips a bounded revision with 100 claims and evidence", async () => {
    await ContentEvidenceRepository.captureSource(scope, {
      mutationId: "capture",
      requestHash: "capture-hash",
      source: {
        id: "source",
        projectId: "project",
        kind: "pasted",
        title: "Source",
        attribution: "Owner",
        sourceText: "Proof",
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
    const claims = Array.from({ length: 100 }, (_, i) => ({
      id: `claim-${i}`,
      target: { kind: "markdown" as const, start: 0, end: 4 },
      text: "Body",
      textHash: "body-hash",
      kind: "general" as const,
      factual: true,
      evidence: [
        {
          id: `evidence-${i}`,
          sourceId: "source",
          start: 0,
          end: 5,
          excerpt: "Proof",
          excerptHash: "proof-hash",
          passageId: "passage",
          relation: "supports" as const,
        },
      ],
    }));
    const prepared = {
      ...write,
      sourceHashes: [{ sourceId: "source", textHash: "source-hash" }],
      revision: { ...write.revision, sourceIds: ["source"], claims },
    };
    expect((await ContentRepository.createRevision(scope, prepared)).ok).toBe(
      true,
    );
    const revision = await ContentRepository.getRevision(
      "organization",
      "project",
      "content",
    );
    expect(revision).toMatchObject({
      id: "revision",
      markdown: "Body",
      sourceIds: ["source"],
    });
    expect(revision?.claims).toHaveLength(100);
    expect(revision?.claims[0].evidence).toHaveLength(1);
    expect(
      await ContentRepository.listRevisions(
        "organization",
        "project",
        "content",
        { limit: 1 },
      ),
    ).toMatchObject({
      items: [{ id: "revision", version: 1 }],
      nextCursor: null,
    });
    expect(
      await ContentEvidenceRepository.getCheckSet(
        "organization",
        "project",
        "content",
        "revision",
        "checks",
      ),
    ).toMatchObject({ id: "checks", checks: [] });
    expect(
      await ContentEvidenceRepository.getCurrentCheckSet(
        "organization",
        "project",
        "content",
        "revision",
      ),
    ).toMatchObject({ id: "checks" });
    expect(
      await ContentEvidenceRepository.listSources(
        "organization",
        "project",
        {},
      ),
    ).toMatchObject({
      items: [{ id: "source", available: true }],
      nextCursor: null,
    });
    expect(
      await ContentRepository.getRevision("foreign", "project", "content"),
    ).toBeNull();
    expect(testDb.maxParameters()).toBeLessThanOrEqual(100);
    await expect(
      testDb.execute("DELETE FROM content_sources WHERE id = 'source'"),
    ).rejects.toThrow();
    expect(await testDb.execute("select id from content_sources")).toHaveLength(
      1,
    );
    expect(
      await testDb.execute("select id from content_revision_sources"),
    ).toHaveLength(1);
    await testDb.execute("DELETE FROM organization WHERE id = 'organization'");
    expect(await testDb.execute("select id from content_items")).toHaveLength(
      0,
    );
  });
});
