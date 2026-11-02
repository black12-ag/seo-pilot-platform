import { sql, type SQL } from "drizzle-orm";
import type { runBatch } from "@/db/runBatch";
import {
  auditIssues,
  auditPages,
  audits,
  contentProjectState,
  contentSources,
  projects,
} from "@/db/schema";

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];

export function lockContentProject(tx: Tx, projectId: string) {
  return tx
    .update(projects)
    .set({ name: sql`${projects.name}` })
    .where(sql`${projects.id} = ${projectId}`);
}

export function bumpContentContext(
  tx: Tx,
  projectId: string,
  condition: SQL = sql`true`,
) {
  return tx
    .insert(contentProjectState)
    .select(
      sql`select p.id, 1, ${Date.now()} from projects p where p.id = ${projectId} and ${condition}`,
    )
    .onConflictDoUpdate({
      target: contentProjectState.projectId,
      set: {
        contextVersion: sql`${contentProjectState.contextVersion} + 1`,
        updatedAtMs: Date.now(),
      },
    });
}

export function lockRevisionSources(
  tx: Tx,
  projectId: string,
  revisionId: string | SQL,
  guard: SQL,
) {
  const references = sql`select rs.source_id from content_revision_sources rs where rs.project_id = ${projectId} and rs.revision_id = ${revisionId}`;
  const auditsForRevision = (column: SQL) =>
    sql`select ${column} from content_source_audit_references ar where ar.project_id = ${projectId} and ar.source_id in (${references})`;
  return [
    tx
      .update(contentSources)
      .set({ title: sql`${contentSources.title}` })
      .where(
        sql`${contentSources.projectId} = ${projectId} and ${contentSources.id} in (${references}) and ${guard}`,
      ),
    tx
      .update(audits)
      .set({ startUrl: sql`${audits.startUrl}` })
      .where(
        sql`${audits.id} in (${auditsForRevision(sql`ar.audit_id`)}) and ${guard}`,
      ),
    tx
      .update(auditPages)
      .set({ url: sql`${auditPages.url}` })
      .where(
        sql`${auditPages.id} in (${auditsForRevision(sql`ar.page_id`)}) and ${guard}`,
      ),
    tx
      .update(auditIssues)
      .set({ pageUrl: sql`${auditIssues.pageUrl}` })
      .where(
        sql`${auditIssues.id} in (${auditsForRevision(sql`ar.issue_id`)}) and ${guard}`,
      ),
  ];
}
