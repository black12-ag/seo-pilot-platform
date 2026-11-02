import { sql } from "drizzle-orm";
import { getDatabaseProvider } from "@/db/provider";
import { DB_BATCH_SIZE } from "@/db/runBatch";
import { auditResultSelect, writeAuditResults } from "./auditRunWrites";
import { auditIssues } from "@/db/schema";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import { AUDIT_ISSUE_TYPES } from "@/shared/audit-issues";

export async function insertIssues(auditId: string, issues: DetectedIssue[]) {
  const isPostgres = getDatabaseProvider() === "postgres";
  // Bound row preparation while preserving D1's 100-row batch requests.
  const batchSize = isPostgres ? 500 : DB_BATCH_SIZE;
  for (let i = 0; i < issues.length; i += batchSize) {
    const issueRows = await Promise.all(
      issues.slice(i, i + batchSize).map(async (issue) => ({
        id: await deterministicAuditRowId(
          auditId,
          issue.pageUrl,
          issue.issueType,
          issue.dedupeKey ?? "",
        ),
        auditId,
        pageId: issue.pageId,
        pageUrl: issue.pageUrl,
        issueType: issue.issueType,
        severity: AUDIT_ISSUE_TYPES[issue.issueType].severity,
        detailsJson: issue.details ? JSON.stringify(issue.details) : null,
      })),
    );
    // D1 limits compound SELECTs to five terms; every term retains the seal guard.
    const groups = [];
    for (let offset = 0; offset < issueRows.length; offset += 5) {
      groups.push(issueRows.slice(offset, offset + 5));
    }
    await writeAuditResults(auditId, groups, (tx, rows) =>
      tx
        .insert(auditIssues)
        .select(
          sql.join(
            rows.map((row) => auditResultSelect(auditIssues, row, auditId)),
            sql` union all `,
          ),
        )
        .onConflictDoNothing(),
    );
  }
}
