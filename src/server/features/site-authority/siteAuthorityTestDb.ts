import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle as sqliteDrizzle } from "drizzle-orm/libsql";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { sort } from "remeda";
// oxlint-disable-next-line no-restricted-imports -- test fixture explicitly exercises both physical dialects
import * as sqliteSchema from "@/db/d1/schema";
// oxlint-disable-next-line no-restricted-imports -- test fixture explicitly exercises both physical dialects
import * as pgSchema from "@/db/pg/schema";
import type { runBatch } from "@/db/runBatch";

// Builders originate in the imported production repository, never external input.
function isSqlQuery(value: unknown): value is {
  toSQL(): { sql: string; params: Array<string | number | null> };
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "toSQL" in value &&
    typeof value.toSQL === "function"
  );
}

type Executor = Parameters<Parameters<typeof runBatch>[0]>[0];

/** Real migrations and atomic batches of production statements on both providers. */
export async function createSiteAuthorityTestDb() {
  const pgUrl = process.env.SITE_AUTHORITY_TEST_PG_URL;
  const provider = pgUrl ? "postgres" : "d1";
  const client = pgUrl ? null : createClient({ url: "file::memory:" });
  const admin = pgUrl ? postgres(pgUrl, { max: 1, onnotice: () => {} }) : null;
  const databaseName = `authority_${crypto.randomUUID().replaceAll("-", "")}`;
  if (admin) await admin.unsafe(`create database "${databaseName}"`);
  const connection = pgUrl ? new URL(pgUrl) : null;
  if (connection) connection.pathname = `/${databaseName}`;
  const pg = connection
    ? postgres(connection.href, { max: 6, onnotice: () => {} })
    : null;
  const pgDb = pg ? pgDrizzle(pg, { schema: pgSchema }) : null;
  const sqliteDb = client
    ? sqliteDrizzle(client, { schema: sqliteSchema })
    : null;
  const execute = async (statement: string) => {
    if (pg) return Array.from(await pg.unsafe(statement));
    if (!client) throw new Error("Missing test database");
    return (await client.execute(statement)).rows;
  };
  const executeMultiple = async (statement: string) => {
    if (pg) {
      await pg.unsafe(statement);
      return;
    }
    if (!client) throw new Error("Missing test database");
    await client.executeMultiple(statement);
  };
  if (client) await client.execute("PRAGMA foreign_keys=ON");
  const directory = `drizzle/${pg ? "pg" : "sqlite"}`;
  for (const file of sort(
    readdirSync(directory).filter((name) => name.endsWith(".sql")),
    (a, b) => a.localeCompare(b),
  )) {
    await executeMultiple(
      readFileSync(`${directory}/${file}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  }
  let failureIndex: number | null = null;
  let beforeBatch: (() => Promise<void>) | null = null;
  let maxParameters = 0;
  let membershipMutation: { index: number; role: string | null } | null = null;
  function prepare(build: Parameters<typeof runBatch>[0], tx: Executor) {
    const statements = [...build(tx)];
    if (failureIndex !== null) {
      void statements.splice(
        failureIndex,
        0,
        tx.update(sqliteSchema.projects).set({ name: sql`null` }),
      );
      failureIndex = null;
    }
    if (membershipMutation) {
      const { index, role } = membershipMutation;
      void statements.splice(
        index,
        0,
        role === null
          ? tx.delete(sqliteSchema.member)
          : tx.update(sqliteSchema.member).set({ role }),
      );
      membershipMutation = null;
    }
    for (const statement of statements) {
      if ("toSQL" in statement && typeof statement.toSQL === "function") {
        if (!isSqlQuery(statement))
          throw new Error("Expected real Drizzle query");
        const compiled = statement.toSQL();
        maxParameters = Math.max(maxParameters, compiled.params.length);
        if (compiled.params.length > 100)
          throw new Error("D1 parameter limit exceeded");
      }
    }
    return statements;
  }
  const database = pgDb ?? sqliteDb;
  if (!database) throw new Error("Missing test database");
  // Provider types are intentionally bridged by the production parity invariant.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- real compatible Drizzle handles
  const db = database as unknown as Executor;
  const atomicBatch: typeof runBatch = async (build) => {
    const callback = beforeBatch;
    beforeBatch = null;
    if (callback) await callback();
    if (pgDb) {
      await pgDb.transaction(async (tx) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- provider-aware production contract
        for (const statement of prepare(build, tx as unknown as Executor))
          await statement;
      });
    } else if (sqliteDb && client) {
      // libsql's batch executes one atomic BEGIN/COMMIT, including fault injection.
      const statements = prepare(build, db).map((statement) => {
        if (!("toSQL" in statement) || typeof statement.toSQL !== "function")
          throw new Error("Expected real Drizzle query");
        if (!isSqlQuery(statement))
          throw new Error("Expected real Drizzle query");
        const compiled = statement.toSQL();
        return { sql: compiled.sql, args: compiled.params };
      });
      const executeBatch = client.batch.bind(client);
      if (statements.length) await executeBatch(statements, "write");
    }
  };
  const seedProject = async () => {
    await executeMultiple(`DELETE FROM organization; DELETE FROM "user";
      INSERT INTO organization (id,name,slug,created_at) VALUES ('organization','Organization','organization',${pg ? "now()" : "0"}),('foreign','Foreign','foreign',${pg ? "now()" : "0"});
      INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ('user','User','authority@example.com',${pg ? "now(),now()" : "0,0"});
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('membership','organization','user','owner',${pg ? "now()" : "0"});
      INSERT INTO projects (id,organization_id,name,domain) VALUES ('project','organization','Project','example.com'),('foreign-project','foreign','Foreign','other.com');`);
  };
  const close = async () => {
    client?.close();
    if (pg) await pg.end();
    if (admin) {
      await admin.unsafe(`drop database "${databaseName}"`);
      await admin.end();
    }
  };
  return {
    db,
    pg,
    provider,
    runBatch: atomicBatch,
    execute,
    executeMultiple,
    seedProject,
    close,
    beforeNextBatch: (callback: () => Promise<void>) => {
      beforeBatch = callback;
    },
    failNextBatchAt: (index: number) => {
      failureIndex = index;
    },
    mutateMembershipInNextBatchAt: (index: number, role: string | null) => {
      membershipMutation = { index, role };
    },
    maxParameters: () => maxParameters,
  };
}
