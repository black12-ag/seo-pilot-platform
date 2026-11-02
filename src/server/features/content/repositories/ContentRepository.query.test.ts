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
import { ContentEvidenceRepository } from "./ContentEvidenceRepository";
import {
  contentTestScope as scope,
  contentTestWrite as write,
} from "../contentTestDb";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe(`content membership (${testDb.provider})`, () => {
  it("returns the current membership identity only within the organization", async () => {
    expect(
      await ContentRepository.getMembership("organization", "user"),
    ).toEqual({
      id: "membership",
      role: "owner",
    });
    expect(await ContentRepository.getMembership("foreign", "user")).toBeNull();
    await testDb.execute("DELETE FROM member WHERE id = 'membership'");
    expect(
      await ContentRepository.getMembership("organization", "user"),
    ).toBeNull();
  });
});

describe(`content revision persistence (${testDb.provider})`, () => {
  it("creates one immutable revision and replays its receipt", async () => {
    expect(await ContentRepository.createRevision(scope, write)).toEqual({
      ok: true,
      resultId: "revision",
      replayed: false,
    });
    expect(await ContentRepository.createRevision(scope, write)).toEqual({
      ok: true,
      resultId: "revision",
      replayed: true,
    });
    expect(
      await ContentRepository.createRevision(scope, {
        ...write,
        requestHash: "changed",
      }),
    ).toEqual({ ok: false, code: "conflict" });
    expect(
      await testDb.execute("select id from content_revisions"),
    ).toHaveLength(1);
  });

  it("leaves no item, receipt, or revision after a transaction fault", async () => {
    testDb.failNextBatchAt(3);
    await expect(
      ContentRepository.createRevision(scope, write),
    ).rejects.toThrow();
    expect(await testDb.execute("select id from content_items")).toHaveLength(
      0,
    );
    expect(
      await testDb.execute("select id from content_revisions"),
    ).toHaveLength(0);
    expect(
      await testDb.execute("select id from content_mutations"),
    ).toHaveLength(0);
  });

  it("admits only one concurrent save at the same head", async () => {
    await ContentRepository.createRevision(scope, write);
    const base = {
      ...write,
      expectedHeadVersion: 1,
      revision: { ...write.revision, version: 2, parentRevisionId: "revision" },
      checkSet: { ...write.checkSet, id: "checks-2" },
    };
    const results = await Promise.all([
      ContentRepository.saveRevision(scope, {
        ...base,
        mutationId: "save-a",
        revision: { ...base.revision, id: "revision-a" },
      }),
      ContentRepository.saveRevision(scope, {
        ...base,
        mutationId: "save-b",
        revision: { ...base.revision, id: "revision-b" },
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "revision_conflict" },
    ]);
    expect(
      await testDb.execute("select id from content_revisions"),
    ).toHaveLength(2);
    expect(
      await testDb.execute("select id from content_check_sets"),
    ).toHaveLength(2);
    expect(
      await ContentRepository.getMutation("organization", "project", "create"),
    ).toEqual({ kind: "create", requestHash: "hash", resultId: "revision" });
    expect(
      await ContentRepository.getMutation("foreign", "project", "create"),
    ).toBeNull();
    expect(
      (
        await ContentRepository.getRevisionById(
          "organization",
          "project",
          "revision",
        )
      )?.version,
    ).toBe(1);
    expect(
      (
        await ContentRepository.getRevisionByVersion(
          "organization",
          "project",
          "content",
          1,
        )
      )?.id,
    ).toBe("revision");
  });

  it("rolls back admitted children when membership disappears mid-batch", async () => {
    testDb.mutateMembershipInNextBatchAt(4, null);
    await expect(
      ContentRepository.createRevision(scope, write),
    ).rejects.toThrow();
    expect(await testDb.execute("select id from content_items")).toHaveLength(
      0,
    );
    expect(
      await testDb.execute("select id from content_revisions"),
    ).toHaveLength(0);
    expect(
      await testDb.execute("select id from content_mutations"),
    ).toHaveLength(0);
  });

  it("archives idempotently while retaining revision history", async () => {
    await ContentRepository.createRevision(scope, write);
    const archiveWrite = {
      input: {
        projectId: "project",
        contentId: "content",
        mutationId: "archive",
        expectedHeadVersion: 1,
      },
      requestHash: "archive-hash",
    };
    expect(await ContentRepository.archive(scope, archiveWrite)).toEqual({
      ok: true,
      resultId: "content",
      replayed: false,
    });
    expect(await ContentRepository.archive(scope, archiveWrite)).toEqual({
      ok: true,
      resultId: "content",
      replayed: true,
    });
    expect(
      (
        await ContentRepository.getRevision(
          "organization",
          "project",
          "content",
        )
      )?.id,
    ).toBe("revision");
    expect(
      await ContentRepository.saveRevision(scope, {
        ...write,
        mutationId: "save",
        expectedHeadVersion: 1,
        revision: {
          ...write.revision,
          id: "next",
          version: 2,
          parentRevisionId: "revision",
        },
      }),
    ).toEqual({ ok: false, code: "revision_conflict" });
  });

  it("keeps all statements within D1 limits with ten pinned sources", async () => {
    for (let i = 0; i < 10; i++) {
      const sourceId = `source-${i}`;
      expect(
        (
          await ContentEvidenceRepository.captureSource(scope, {
            mutationId: `capture-${i}`,
            requestHash: `hash-${i}`,
            source: {
              id: sourceId,
              projectId: "project",
              kind: "pasted",
              title: "Source",
              attribution: "Owner",
              sourceText: "Proof",
              textHash: `text-${i}`,
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
          })
        ).ok,
      ).toBe(true);
    }
    const sourceIds = Array.from({ length: 10 }, (_, i) => `source-${i}`);
    expect(
      (
        await ContentRepository.createRevision(scope, {
          ...write,
          sourceHashes: sourceIds.map((sourceId, i) => ({
            sourceId,
            textHash: `text-${i}`,
          })),
          revision: { ...write.revision, sourceIds },
        })
      ).ok,
    ).toBe(true);
    expect(testDb.maxParameters()).toBeLessThanOrEqual(100);
  });
});

if (testDb.provider === "postgres") {
  it("installs the scoped source FK as initially deferred NO ACTION", async () => {
    const rows = await testDb.execute(
      "select condeferrable, condeferred, confdeltype from pg_constraint where conrelid = 'content_revision_sources'::regclass and confrelid = 'content_sources'::regclass",
    );
    expect(rows).toMatchObject([
      { condeferrable: true, condeferred: true, confdeltype: "a" },
    ]);
  });
}
