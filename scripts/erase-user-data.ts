/**
 * GDPR account erasure for the hosted Postgres deployment.
 *
 * Dry run (the default):
 *   pnpm gdpr:erase-user --email person@example.com
 *
 * Execute after reviewing the inventory:
 *   pnpm gdpr:erase-user --email person@example.com \
 *     --execute --confirm person@example.com \
 *     --confirm-database-host <host printed by the dry run>
 *
 * The Worker endpoint must be deployed with the same GDPR_ERASURE_SECRET as
 * this process. See docs/maintainers/runbooks/gdpr-erasure.md for required operator variables.
 */
import process from "node:process";
import { Autumn } from "autumn-js";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import {
  GDPR_STORAGE_ERASURE_PATH,
  signGdprErasureRequest,
  type GdprStorageErasurePayload,
} from "../src/shared/gdpr-erasure";
import { loadLocalEnv, parseArgs } from "./cli-utils";
import { buildInventory, type Db, type UserRow } from "./erasure/inventory";
import { erasePostgres, verifyPostgres } from "./erasure/postgres";
// The Node-safe raw barrel (not ../src/db/schema, the provider-aware one,
// which imports cloudflare:workers).
import * as schema from "../src/db/pg/schema";

loadLocalEnv();

const args = parseArgs(process.argv.slice(2));
const execute = args.execute === "true";
const emailSelector = args.email?.trim().toLowerCase();
const userIdSelector = args["user-id"]?.trim();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

function printUsage(): never {
  throw new Error(
    "Pass exactly one selector: --email person@example.com or --user-id <id>. Add --execute --confirm <exact-email> only after reviewing the dry run.",
  );
}

async function findUser(db: Db): Promise<UserRow> {
  if (Boolean(emailSelector) === Boolean(userIdSelector)) printUsage();
  const rows = await db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      name: schema.user.name,
    })
    .from(schema.user)
    .where(
      emailSelector
        ? sql`lower(${schema.user.email}) = ${emailSelector}`
        : eq(schema.user.id, userIdSelector ?? ""),
    )
    .limit(2);
  if (rows.length === 0) throw new Error("No matching user found.");
  if (rows.length !== 1) throw new Error("Selector matched multiple users.");
  return rows[0];
}

async function deleteLoopsContactBy(selector: {
  userId?: string;
  email?: string;
}) {
  const response = await fetch("https://app.loops.so/api/v1/contacts/delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("LOOPS_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(selector),
  });
  if (response.status === 404) return "already_absent";
  if (!response.ok) {
    throw new Error(
      `Loops deletion failed (${response.status}): ${await response.text()}`,
    );
  }
  return "deleted";
}

async function deleteLoopsContact(userId: string, email: string) {
  // Waitlist signups (web/src/routes/api/subscribe.ts) create contacts with
  // email only, and the app-side userId backfill is best-effort — so delete by
  // each selector. The Loops API rejects a request carrying both.
  return {
    byUserId: await deleteLoopsContactBy({ userId }),
    byEmail: await deleteLoopsContactBy({ email }),
  };
}

async function deletePostHogPerson(userId: string) {
  const host = optionalEnv(
    "POSTHOG_API_HOST",
    "https://us.posthog.com",
  ).replace(/\/$/u, "");
  const projectId = encodeURIComponent(requiredEnv("POSTHOG_PROJECT_ID"));
  const authorization = `Bearer ${requiredEnv("POSTHOG_PERSONAL_API_KEY")}`;
  // A distinct_id filter matches at most one person, so a single page is
  // enough; `next` is deliberately ignored.
  const listUrl = new URL(`${host}/api/projects/${projectId}/persons/`);
  listUrl.searchParams.set("distinct_id", userId);
  const listResponse = await fetch(listUrl, {
    headers: { Authorization: authorization },
  });
  if (!listResponse.ok) {
    throw new Error(
      `PostHog lookup failed (${listResponse.status}): ${await listResponse.text()}`,
    );
  }
  const people = z
    .object({
      results: z.array(
        z.object({
          id: z.union([z.string(), z.number()]).optional(),
          uuid: z.string().optional(),
        }),
      ),
    })
    .parse(await listResponse.json()).results;
  for (const person of people) {
    const personId = person.id ?? person.uuid;
    if (personId === undefined)
      throw new Error("PostHog returned a person without an id.");
    const response = await fetch(
      `${host}/api/projects/${projectId}/persons/${encodeURIComponent(String(personId))}/?delete_events=true`,
      { method: "DELETE", headers: { Authorization: authorization } },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `PostHog deletion failed (${response.status}): ${await response.text()}`,
      );
    }
  }
  return people.length;
}

/**
 * The Autumn key prefix encodes which environment it targets. A sandbox key
 * against production data would 404 every delete and leave the live Stripe
 * subscription running — surface the environment in the dry run so the
 * operator can catch that before executing.
 */
function autumnEnvironment(): string {
  const key = process.env.AUTUMN_SECRET_KEY?.trim() ?? "";
  if (key.startsWith("am_sk_live_")) return "live";
  if (key.startsWith("am_sk_test_")) return "sandbox";
  return "unset-or-unknown";
}

async function deleteAutumnCustomer(organizationIds: string[]) {
  const autumn = new Autumn({ secretKey: requiredEnv("AUTUMN_SECRET_KEY") });
  let deleted = 0;
  let absent = 0;
  for (const organizationId of organizationIds) {
    try {
      await autumn.customers.delete({
        customerId: organizationId,
        deleteInStripe: true,
      });
      deleted += 1;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      absent += 1;
    }
  }
  return { deleted, absent };
}

async function eraseWorkerStorage(payload: GdprStorageErasurePayload) {
  const secret = requiredEnv("GDPR_ERASURE_SECRET");
  const endpoint = new URL(
    GDPR_STORAGE_ERASURE_PATH,
    requiredEnv("BETTER_AUTH_URL"),
  );
  if (endpoint.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use https for GDPR erasure.");
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = await signGdprErasureRequest(secret, timestamp, body);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-gdpr-timestamp": timestamp,
      "x-gdpr-signature": signature,
    },
    body,
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Worker storage erasure failed (${response.status}): ${responseBody}`,
    );
  }
  return z
    .object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(responseBody) as unknown).result;
}

async function main() {
  const connectionString = requiredEnv("POSTGRES_DATABASE_URL");
  const databaseUrl = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error(
      "POSTGRES_DATABASE_URL must use postgres:// or postgresql://.",
    );
  }
  const databaseHost = databaseUrl.hostname;
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);
  try {
    const user = await findUser(db);
    const inventory = await buildInventory(db, user);
    const summary = {
      mode: execute ? "execute" : "dry-run",
      databaseHost,
      user: { id: user.id, email: user.email, name: user.name },
      organizations: inventory.organizations,
      databaseCounts: inventory.databaseCounts,
      cloudflare: {
        samChats: inventory.samSessionIds.length,
        auditScratchpads: inventory.auditIds.length,
        r2Objects: inventory.r2Keys.length,
        activeAuditWorkflows: inventory.activeAuditWorkflowIds.length,
        activeRankWorkflows: inventory.activeRankWorkflowIds.length,
        activeLocalRankWorkflows: inventory.activeLocalRankWorkflowIds.length,
      },
      external: {
        googleAccounts: inventory.googleAccounts.length,
        loopsContact: true,
        postHogDistinctId: user.id,
        autumnCustomersAndStripeCustomers: inventory.organizations.length,
        autumnEnvironment: autumnEnvironment(),
      },
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!execute) {
      console.log(
        "\nDry run only. Re-run with --execute --confirm <exact-email> after review.",
      );
      return;
    }
    if (args.confirm?.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new Error(
        "--confirm must exactly match the selected user's email.",
      );
    }
    if (args["confirm-database-host"]?.trim() !== databaseHost) {
      throw new Error(
        `--confirm-database-host must exactly match ${databaseHost}.`,
      );
    }

    const organizationIds = inventory.organizations.map(
      (organization) => organization.id,
    );
    const loops = await deleteLoopsContact(user.id, user.email);
    const postHogPeopleQueued = await deletePostHogPerson(user.id);
    const autumnResult = await deleteAutumnCustomer(organizationIds);
    const storage = await eraseWorkerStorage({
      userId: user.id,
      email: user.email,
      organizationIds,
      samSessionIds: inventory.samSessionIds,
      auditIds: inventory.auditIds,
      activeAuditWorkflowIds: inventory.activeAuditWorkflowIds,
      activeRankWorkflowIds: inventory.activeRankWorkflowIds,
      activeAiVisibilityWorkflowIds: inventory.activeAiVisibilityWorkflowIds,
      activeLocalRankWorkflowIds: inventory.activeLocalRankWorkflowIds,
      aiVisibilityProjectIds: inventory.aiVisibilityProjectIds,
      r2Keys: inventory.r2Keys,
      googleAccounts: inventory.googleAccounts,
    });
    const contentErasure = await erasePostgres(db, user, organizationIds);
    const postgresVerification = await verifyPostgres(
      db,
      user.id,
      organizationIds,
      contentErasure,
    );

    console.log(
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          userId: user.id,
          email: user.email,
          vendors: { loops, postHogPeopleQueued, autumn: autumnResult },
          storage,
          postgres: postgresVerification,
          retentionNotes: [
            "PostHog event deletion is asynchronous after the person deletion request.",
            "Completed Cloudflare Workflow state and Workers logs expire under the account retention policy.",
            "Database backups and financial records remain only for their documented legal/backup retention periods.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`GDPR erasure failed: ${errorText(error)}`);
  process.exitCode = 1;
});
