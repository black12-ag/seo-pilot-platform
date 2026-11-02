import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
  DurableObject: vi.fn(),
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/features/ai-visibility/services/aiVisibilityRuns", () => ({
  startRun: vi.fn(),
}));
vi.mock("@/server/features/projects/services/websiteResearch", () => ({
  researchWebsite: vi.fn(),
}));
vi.mock("@/server/billing/subscription", () => ({
  checkUsageCreditsDepleted: vi.fn(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
}));
import { projectCompetitors } from "@/db/schema";
import { ProjectWebsiteService } from "./ProjectWebsiteService";
import { customer } from "@/server/features/ai-visibility/services/aiVisibilityTestFixtures";

const projectId = "4a5b6c7d-0000-4000-8000-000000000000";
const project = { name: "Saved name" };
const accepted = {
  projectId,
  name: "Researched name",
  domain: "researched.com",
  overview: "Researched overview".padEnd(4000, "."),
  competitors: [
    {
      name: "Researched rival",
      domain: "rival.com",
      notes: "Researched notes",
    },
    { name: "New rival", domain: "new-rival.com", notes: "New notes" },
    // Cross the D1 chunk boundary: earlier inserts must not block later ones.
    ...Array.from({ length: 10 }, (_, index) => ({
      name: `Extra rival ${index}`,
      domain: `extra-rival-${index}.com`,
      notes: "",
    })),
  ],
  suggestedTopics: [
    {
      name: "new keyword",
      prompts: [1, 2, 3, 4, 5].map((n) => `New question ${n}?`),
    },
  ],
  suggestedKeywords: ["site audit"],
};

afterAll(testDb.close);
beforeEach(async () => {
  await testDb.seedProject();
  await testDb.executeMultiple(`DELETE FROM projects;
    INSERT INTO projects (id, organization_id, name, location_code, language_code) VALUES ('${projectId}', '${customer.organizationId}', '${project.name}', 2840, 'en');`);
});

async function saveContext() {
  await testDb.executeMultiple(`INSERT INTO project_context_sections (project_id, key, content, updated_by) VALUES ('${projectId}', 'business_overview', 'User overview', 'user');
    INSERT INTO project_competitors (id, project_id, domain, name, notes, updated_by) VALUES ('saved', '${projectId}', 'rival.com', 'User rival', 'User notes', 'user');`);
}

describe("ProjectWebsiteService.save", () => {
  it("fills missing fields without replacing an existing project name", async () => {
    await ProjectWebsiteService.save(accepted, customer, "user");
    expect(
      await testDb.execute(
        "SELECT name, domain, ai_research_keywords FROM projects",
      ),
    ).toEqual([
      {
        name: project.name,
        domain: accepted.domain,
        ai_research_keywords: "new keyword\nsite audit",
      },
    ]);
    expect(
      new Set(
        (
          await testDb.db
            .select({ domain: projectCompetitors.domain })
            .from(projectCompetitors)
        ).map((row) => row.domain),
      ),
    ).toEqual(new Set(accepted.competitors.map((row) => row.domain)));
    expect(
      (await testDb.execute("SELECT content FROM project_context_sections"))[0]
        ?.content,
    ).toBe(accepted.overview);
    expect(
      await testDb.execute("SELECT context_version FROM content_project_state"),
    ).toMatchObject([{ context_version: 1 }]);
  });

  it.each(["before review", "during save"])(
    "preserves context saved %s, including the whole competitor list",
    async (timing) => {
      const edit = async () => {
        await saveContext();
        await testDb.execute(
          "UPDATE projects SET name = 'User name', domain = 'user.com', ai_research_keywords = 'user keyword'",
        );
      };
      if (timing === "before review") {
        await edit();
      } else testDb.beforeNextBatch(edit);

      await ProjectWebsiteService.save(accepted, customer, "user");

      expect(
        await testDb.execute(
          "SELECT name, domain, ai_research_keywords FROM projects",
        ),
      ).toEqual([
        {
          name: "User name",
          domain: "user.com",
          ai_research_keywords: "user keyword",
        },
      ]);
      expect(
        await testDb.execute(
          "SELECT content, updated_by FROM project_context_sections",
        ),
      ).toEqual([{ content: "User overview", updated_by: "user" }]);
      expect(
        await testDb.execute(
          "SELECT domain, name, notes FROM project_competitors",
        ),
      ).toEqual([
        { domain: "rival.com", name: "User rival", notes: "User notes" },
      ]);
    },
  );
});
