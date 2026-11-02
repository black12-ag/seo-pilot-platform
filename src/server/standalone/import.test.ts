import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const {
  client: database,
  prepare: prepareQuery,
  executeBatch: runImportBatch,
  operatorSecret,
} = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { sort } = await import("remeda");
  const { readdirSync, readFileSync } = await import("node:fs");
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  for (const file of sort(
    readdirSync("drizzle/sqlite").filter((name) => name.endsWith(".sql")),
    (a, b) => a.localeCompare(b),
  )) {
    await client.executeMultiple(
      readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  }
  function prepare(sql: string) {
    const statement = { sql, args: [] as Array<string | number | null> };
    return {
      statement,
      bind(...args: Array<string | number | null>) {
        statement.args = args;
        return this;
      },
      async all() {
        return { results: (await client.execute(statement)).rows };
      },
      async first() {
        return (await client.execute(statement)).rows[0] ?? null;
      },
    };
  }
  const executeBatch = async (
    statements: Array<ReturnType<typeof prepare>>,
  ) => {
    await client.batch(
      statements.map((query) => query.statement),
      "write",
    );
  };
  return {
    client,
    prepare,
    executeBatch,
    operatorSecret: "fixture-import-operator-secret-only",
  };
});
vi.mock("cloudflare:workers", () => ({
  env: {
    OPENSEO_OPERATOR_SECRET: operatorSecret,
    DB: { prepare: prepareQuery },
    KV: { get: async () => "active-import" },
  },
}));
vi.mock("agents", () => ({ getAgentByName: vi.fn() }));
vi.mock("@/db/runBatch", () => ({ runD1ImportBatch: runImportBatch }));
import { handleImport } from "./import";
afterAll(() => database.close());
beforeEach(async () => {
  await database.executeMultiple(`delete from organization; delete from "user";
    insert into organization(id,name,slug,created_at) values('organization','Org','org',0);
    insert into projects(id,organization_id,name,domain) values('project','organization','Project','example.com');`);
});
const columns = [
  "project_id",
  "organization_id",
  "version",
  "state",
  "start_url",
  "cadence",
  "time_zone",
  "hour",
  "minute",
  "max_pages",
  "render_javascript",
  "lighthouse_strategy",
  "max_cost_micros_per_run",
  "max_cost_micros_per_utc_day",
  "max_pages_per_utc_day",
  "max_runs_per_utc_day",
  "estimate_fingerprint",
  "policy_fingerprint",
  "next_due_at_ms",
  "updated_at_ms",
  "mutation_token",
];
const row = [
  "project",
  "organization",
  4,
  "enabled",
  "https://example.com",
  "daily",
  "UTC",
  6,
  0,
  10,
  0,
  "none",
  0,
  0,
  10,
  1,
  "a",
  "b",
  1800000000000,
  1,
  "token",
];
function request(inputColumns = columns, rows = [row]) {
  return new Request("https://local.test/operator/import", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openseo-operator-secret": operatorSecret,
    },
    body: JSON.stringify({
      command: "rows",
      table: "audit_schedules",
      columns: inputColumns,
      rows,
    }),
  });
}
describe("protected recurring schedule restore", () => {
  it("imports a paused revision with no due instant and cannot reenable on replay", async () => {
    expect((await handleImport(request())).status).toBe(200);
    expect((await handleImport(request())).status).toBe(200);
    expect(
      (
        await database.execute(
          "select state,version,next_due_at_ms from audit_schedules",
        )
      ).rows,
    ).toEqual([
      expect.objectContaining({
        state: "paused",
        version: 5,
        next_due_at_ms: null,
      }),
    ]);
  });
  it("rejects partial schedule columns and invalid version before writing", async () => {
    expect(
      (
        await handleImport(
          request(["project_id", "state"], [["project", "enabled"]]),
        )
      ).status,
    ).toBe(400);
    const invalid = [...row];
    invalid[2] = "4";
    expect((await handleImport(request(columns, [invalid]))).status).toBe(400);
    expect(
      (await database.execute("select * from audit_schedules")).rows,
    ).toHaveLength(0);
  });
  it("never accepts an unauthenticated import", async () => {
    const req = request();
    req.headers.delete("x-openseo-operator-secret");
    expect((await handleImport(req)).status).toBe(404);
  });
});
