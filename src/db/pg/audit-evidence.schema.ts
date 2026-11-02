import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  foreignKey,
  index,
  check,
} from "drizzle-orm/pg-core";
import { audits } from "./audit.schema";
import { projects } from "./app.schema";

// Immutable manifest is a bounded historical value, not relational state.
export const auditRunEvidence = pgTable(
  "audit_run_evidence",
  {
    auditId: text("audit_id")
      .primaryKey()
      .references(() => audits.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    manifestJson: text("manifest_json").notNull(),
    artifactKey: text("artifact_key").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    coverageState: text("coverage_state", {
      enum: ["unassessed", "partial", "complete"],
    }).notNull(),
    observedStartAtMs: bigint("observed_start_at_ms", { mode: "number" }),
    observedEndAtMs: bigint("observed_end_at_ms", { mode: "number" }),
    finalizedAtMs: bigint("finalized_at_ms", { mode: "number" }).notNull(),
    sealToken: text("seal_token").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.auditId],
      foreignColumns: [audits.projectId, audits.id],
      name: "audit_evidence_project_audit_fk",
    }).onDelete("no action"),
    index("audit_evidence_project_time_idx").on(t.projectId, t.finalizedAtMs),
    check(
      "audit_evidence_state_check",
      sql`${t.coverageState} in ('unassessed','partial','complete')`,
    ),
    check(
      "audit_evidence_hash_check",
      sql`length(${t.artifactSha256}) = 64 and ${t.finalizedAtMs} >= 0`,
    ),
  ],
);
