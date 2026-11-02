import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { buildInventory } from "./inventory";

const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../src/server/features/site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe.skipIf(testDb.provider !== "postgres")("erasure inventory", () => {
  it("counts attributed content and refuses a currently shared organization", async () => {
    if (!testDb.pg) throw new Error("PostgreSQL fixture required");
    await testDb.executeMultiple(`
      INSERT INTO content_mutations (id,project_id,mutation_id,request_hash,kind,result_id,completed,created_at_ms) VALUES ('receipt','project','capture','hash','capture','source',1,1);
      INSERT INTO content_sources (id,project_id,mutation_receipt_id,kind,title,attribution,source_text,text_hash,captured_at_ms,extraction_method,extraction_version,extraction_status,created_by_user_id) VALUES ('source','project','receipt','pasted','Title','Owner','Text','hash',1,'pasted','1','usable','user');
    `);
    const db = drizzle(testDb.pg);
    const user = { id: "user", name: "User", email: "authority@example.com" };
    expect((await buildInventory(db, user)).databaseCounts).toMatchObject({
      content_sources: 1,
      attributed_content_sources: 1,
    });
    await testDb.executeMultiple(`
      INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ('other','Other','other@example.com',now(),now());
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('other-member','organization','other','member',now());
    `);
    await expect(buildInventory(db, user)).rejects.toThrow(
      "Refusing to erase shared organization",
    );
  });
});
