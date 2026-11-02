import {
  and,
  eq,
  getTableColumns,
  isNull,
  sql,
  SQL,
  type Table,
} from "drizzle-orm";
import { db } from "@/db";
import { runBatch, DB_BATCH_SIZE } from "@/db/runBatch";
import { audits } from "@/db/schema";
import type { AuditConfig } from "@/server/lib/audit/types";

export async function createAudit(data: {
  isScheduled?: boolean;
  id: string;
  projectId: string;
  startedByUserId: string;
  startUrl: string;
  workflowInstanceId: string;
  config: AuditConfig;
  pagesTotal: number;
  lighthouseTotal: number;
}) {
  await db
    .insert(audits)
    .values({
      id: data.id,
      isScheduled: data.isScheduled ?? false,
      projectId: data.projectId,
      startedByUserId: data.startedByUserId,
      startUrl: data.startUrl,
      requestedStartUrl: data.startUrl,
      requestedConfig: JSON.stringify({
        maxPages: data.config.maxPages,
        lighthouseStrategy: data.config.lighthouseStrategy,
        renderJavaScript: data.config.renderJavaScript ?? false,
      }),
      workflowInstanceId: data.workflowInstanceId,
      config: JSON.stringify(data.config),
      status: "running",
      pagesTotal: data.pagesTotal,
      lighthouseTotal: data.lighthouseTotal,
      currentPhase: "discovery",
    })
    .onConflictDoNothing();
}

/** Records where the crawl really starts, once the workflow has probed the site. */
export async function updateAuditStart(
  auditId: string,
  startUrl: string,
  config: AuditConfig,
) {
  await db
    .update(audits)
    .set({ startUrl, config: JSON.stringify(config) })
    .where(auditWritable(auditId));
}

export async function updateAuditProgress(
  auditId: string,
  workflowInstanceId: string,
  data: {
    pagesCrawled?: number;
    pagesTotal?: number;
    lighthouseTotal?: number;
    lighthouseCompleted?: number;
    lighthouseFailed?: number;
    currentPhase?: string;
  },
) {
  await db
    .update(audits)
    .set(data)
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
        auditWritable(auditId),
      ),
    );
}

export async function completeAudit(
  auditId: string,
  workflowInstanceId: string,
  data: {
    pagesCrawled: number;
    pagesTotal: number;
  },
) {
  await db
    .update(audits)
    .set({
      status: "completed",
      completedAt: new Date().toISOString(),
      currentPhase: "completed",
      ...data,
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
        auditWritable(auditId),
      ),
    );
}

export async function failAudit(
  auditId: string,
  workflowInstanceId: string,
  errorInfo?: {
    errorCode: string;
    errorDetail: string;
    failedPhase: string | null;
  },
) {
  // Only a running audit can transition to failed: the getStatus reconciler
  // races the workflow's own finalize, and without this guard it could flip
  // a just-completed audit to failed.
  const rows = await db
    .update(audits)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      currentPhase: "failed",
      ...(errorInfo && {
        errorCode: errorInfo.errorCode,
        errorDetail: errorInfo.errorDetail,
        failedPhase: errorInfo.failedPhase,
      }),
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
        auditWritable(auditId),
        eq(audits.status, "running"),
      ),
    )
    .returning({ id: audits.id });
  return rows.length === 1;
}

/** The audit row lock serializes result batches with beginSeal on PostgreSQL. */
function auditWritable(auditId: string) {
  return and(
    eq(audits.id, auditId),
    eq(audits.status, "running"),
    isNull(audits.evidenceSealToken),
  );
}

type AuditTx = Parameters<Parameters<typeof runBatch>[0]>[0];
export async function writeAuditResults<T>(
  auditId: string,
  rows: T[],
  build: (tx: AuditTx, row: T) => Promise<unknown>,
) {
  for (let offset = 0; offset < rows.length; offset += DB_BATCH_SIZE - 1) {
    await runBatch((tx) => [
      tx
        .update(audits)
        .set({ status: sql`${audits.status}` })
        .where(auditWritable(auditId)),
      ...rows
        .slice(offset, offset + DB_BATCH_SIZE - 1)
        .map((row) => build(tx, row)),
    ]);
  }
}

/** INSERT SELECT repeats the guard even when the locking UPDATE matched no row. */
export function auditResultSelect(
  table: Table,
  row: Record<string, unknown>,
  auditId: string,
): SQL {
  const values = Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value: unknown = row[key] ?? column.default ?? null;
    return value instanceof SQL ? value : sql`${sql.param(value, column)}`;
  });
  return sql`select ${sql.join(values, sql`, `)} where exists (select 1 from ${audits} where ${auditWritable(auditId)})`;
}
