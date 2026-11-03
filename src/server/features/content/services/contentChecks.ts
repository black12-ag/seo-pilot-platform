import { sha256Hex } from "@/server/lib/audit/ids";
import type { SavedContentRevision } from "@/types/schemas/content";
import type { SavedContentSource } from "@/types/schemas/contentEvidence";

const ruleVersion = "manual-v2";
type Check = {
  claimId: string | null;
  field: string | null;
  rule: string;
  status: string;
  severity: string;
  explanation: string;
};

export async function createContentCheckSet(
  revision: Pick<
    SavedContentRevision,
    | "markdown"
    | "metadata"
    | "brief"
    | "claims"
    | "sourceIds"
    | "contentHash"
    | "contextHash"
    | "sourceSetHash"
    | "openQuestions"
    | "omissions"
  >,
  sources: ReadonlyMap<string, SavedContentSource>,
  nowMs: number,
) {
  const checks: Check[] = [];
  const seen = new Set<string>();
  const add = (
    rule: string,
    status: string,
    severity: string,
    explanation: string,
    target: { claimId?: string; field?: string } = {},
  ) => {
    const { claimId = null, field = null } = target;
    const key = JSON.stringify([claimId, field, rule, status]);
    if (!seen.has(key)) {
      seen.add(key);
      checks.push({ claimId, field, rule, status, severity, explanation });
    }
  };
  for (const sourceId of revision.sourceIds) {
    const source = sources.get(sourceId);
    if (!source)
      add(
        "source_availability",
        "unknown",
        "blocker",
        "Referenced source is unavailable.",
      );
    else if (
      nowMs - source.capturedAtMs >
      (revision.brief.freshnessMaxAgeDays ?? 30) * 86_400_000
    )
      add(
        "source_freshness",
        "stale",
        "warning",
        "A referenced source exceeds the general freshness limit.",
      );
    if (source && source.extractionStatus !== "usable")
      add(
        "source_coverage",
        source.extractionStatus === "partial" ? "partial" : "unknown",
        "warning",
        "Source extraction is incomplete or unavailable.",
      );
  }
  for (const claim of revision.claims) {
    if (!claim.factual) continue;
    const sensitive = ["product", "security", "financial", "legal"].includes(
      claim.kind,
    );
    const hasSupport = claim.evidence.some(
      (entry) => entry.relation === "supports",
    );
    const hasContradiction = claim.evidence.some(
      (entry) => entry.relation === "contradicts",
    );
    add(
      "claim_support",
      hasContradiction
        ? "contradicted"
        : hasSupport
          ? "not_assessed"
          : "unsupported",
      sensitive && (hasContradiction || !hasSupport) ? "blocker" : "warning",
      hasContradiction
        ? "Evidence is marked as contradictory."
        : hasSupport
          ? "Human assessment of support is required."
          : "No supporting evidence was attached.",
      { claimId: claim.id },
    );
    for (const entry of claim.evidence) {
      const source = sources.get(entry.sourceId);
      if (!source) {
        add(
          "source_availability",
          "unknown",
          "blocker",
          "Referenced source is unavailable.",
          { claimId: claim.id },
        );
        continue;
      }
      const limit = Math.min(
        ["product", "security", "financial"].includes(claim.kind) ? 7 : 30,
        revision.brief.freshnessMaxAgeDays ?? 30,
      );
      if (nowMs - source.capturedAtMs > limit * 86_400_000)
        add(
          "source_freshness",
          "stale",
          "warning",
          `Source capture exceeds ${limit} days.`,
          { claimId: claim.id },
        );
      if (source.extractionStatus !== "usable")
        add(
          "source_coverage",
          source.extractionStatus === "partial" ? "partial" : "unknown",
          "warning",
          "Source extraction is incomplete or unavailable.",
          { claimId: claim.id },
        );
      if (!source.publisherDate)
        add("publisher_date", "unknown", "info", "Publisher date is unknown.", {
          claimId: claim.id,
        });
      if (
        (source.language &&
          source.language !== revision.brief.locale.language) ||
        (source.market && source.market !== revision.brief.locale.country)
      )
        add(
          "source_locale",
          "mismatch",
          "warning",
          "Source locale differs from the brief.",
          { claimId: claim.id },
        );
    }
  }
  if (revision.openQuestions.length || revision.omissions.length)
    add(
      "unresolved_questions",
      "unknown",
      "warning",
      "Open questions or omissions remain.",
    );
  if (!revision.metadata.title.trim())
    add("title", "missing", "warning", "Title is empty.", { field: "title" });
  if (!revision.markdown.trim())
    add("body", "missing", "warning", "Markdown body is empty.");
  add(
    "factual_coverage",
    "not_assessed",
    "info",
    "Automatic checks do not determine whether every factual claim was identified.",
  );
  const hash = await sha256Hex(
    JSON.stringify({
      ruleVersion,
      contentHash: revision.contentHash,
      contextHash: revision.contextHash,
      sourceSetHash: revision.sourceSetHash,
      checks,
    }),
  );
  const id = crypto.randomUUID();
  return {
    id,
    hash,
    ruleVersion,
    createdAtMs: nowMs,
    checks: checks.map((check, index) => ({
      id: `${id}-${String(index).padStart(4, "0")}`,
      ...check,
    })),
  };
}
