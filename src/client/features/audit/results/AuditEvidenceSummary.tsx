import { useMutation, useQuery } from "@tanstack/react-query";
import { QueryState } from "@/client/components/QueryState";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/client/components/ui/card";
import { Badge } from "@/client/components/ui/badge";
import { downloadFile } from "@/client/lib/download";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { exportAuditEvidence } from "@/serverFunctions/audit-evidence";
import { auditEvidenceQuery } from "./auditEvidenceQueries";
import { AuditComparison } from "./AuditComparison";
import { auditScheduleQuery } from "../schedule/auditScheduleQueries";

const observation = (ms: number | null) =>
  ms === null ? "Unknown" : new Date(ms).toLocaleString();

export function AuditEvidenceSummary({
  projectId,
  auditId,
}: {
  projectId: string;
  auditId: string;
}) {
  const query = useQuery(auditEvidenceQuery(projectId, auditId));
  const schedule = useQuery(auditScheduleQuery(projectId));
  const download = useMutation({
    mutationFn: () => exportAuditEvidence({ data: { projectId, auditId } }),
    onSuccess: (result) =>
      downloadFile(result.content, result.filename, result.contentType),
  });
  return (
    <Card id="audit-evidence">
      <CardHeader>
        <div className="flex flex-wrap justify-between gap-3">
          <CardTitle>
            <h2>Saved evidence</h2>
          </CardTitle>
          <Button
            variant="outline"
            pending={download.isPending}
            disabled={
              !query.data ||
              query.data.state === "pending" ||
              query.data.state === "deleted"
            }
            onClick={() => download.mutate()}
          >
            Export evidence JSON
          </Button>
        </div>
        <CardDescription>
          Immutable observations of the declared scope. Missing coverage is
          unknown, not a clean bill of health.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <QueryState query={query} errorFallback="Could not load evidence">
          {(data) => {
            const manifest = data.manifest;
            if (!manifest)
              return (
                <p role="status" className="text-sm">
                  {data.state === "legacy_unknown"
                    ? "Legacy coverage unknown. This audit predates sealed evidence; its stored rows can still be exported."
                    : data.state === "deleted"
                      ? "This audit result was deleted. Its attempt is retained; no evidence download is available."
                      : "Evidence is not sealed yet. Coverage remains unknown until finalization."}
                </p>
              );
            const coverage = manifest.coverage;
            const next = schedule.data?.schedule?.nextDueAtMs;
            const overdue = next != null && Date.now() > next;
            return (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">Coverage: {coverage.state}</Badge>
                  <Badge variant="outline">
                    {manifest.source.replaceAll("_", " ")}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {overdue
                      ? "Next observation overdue"
                      : manifest.observedEndAtMs == null
                        ? "Freshness unknown"
                        : `Observed ${Math.max(0, Math.floor((Date.now() - manifest.observedEndAtMs) / 3_600_000))} hours ago`}
                  </span>
                </div>
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                  {[
                    ["Discovered (lower bound)", coverage.discoveredLowerBound],
                    ["Pending", coverage.pending ?? "Unknown"],
                    ["Attempted", coverage.attempted],
                    ["Successfully assessed", coverage.assessed],
                    ["Errors", coverage.errors],
                    ["Blocked", coverage.blocked],
                    ["Rate limited", coverage.rateLimited],
                    ["Unrendered shells", coverage.unrenderedShell],
                  ].map(([label, value]) => (
                    <div key={label} className="border rounded-md p-3">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 text-xl font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="space-y-2 text-sm">
                  <p>
                    Requested:{" "}
                    <SafeExternalLink
                      url={manifest.requested.startUrl}
                      label={manifest.requested.startUrl}
                      className="inline-flex items-center gap-1 break-all underline"
                    />
                  </p>
                  <p>
                    Effective:{" "}
                    <SafeExternalLink
                      url={manifest.effective.startUrl}
                      label={manifest.effective.startUrl}
                      className="inline-flex items-center gap-1 break-all underline"
                    />
                  </p>
                  <p>
                    Observed: {observation(manifest.observedStartAtMs)} –{" "}
                    {observation(manifest.observedEndAtMs)}. Sealed:{" "}
                    {observation(manifest.finalizedAtMs)}.
                  </p>
                  <p>
                    Engine {manifest.engineVersion} · ruleset{" "}
                    {manifest.rulesetVersion} · normalization{" "}
                    {manifest.normalizationVersion}
                  </p>
                  <p>
                    Requested limits: {manifest.requested.config.maxPages} pages
                    · rendering{" "}
                    {manifest.requested.config.renderJavaScript ? "on" : "off"}{" "}
                    · Lighthouse {manifest.requested.config.lighthouseStrategy}.
                  </p>
                  <p>
                    Next scheduled observation:{" "}
                    {next == null ? "Not scheduled" : observation(next)}. A
                    failed or blocked attempt does not refresh this evidence.
                  </p>
                  <p>
                    Scope: {manifest.sourceScope} · page limit{" "}
                    {manifest.effective.config.maxPages} · rendering{" "}
                    {manifest.effective.config.renderJavaScript ? "on" : "off"}{" "}
                    · Lighthouse {manifest.effective.config.lighthouseStrategy}
                  </p>
                  <p>
                    Lighthouse: {coverage.lighthouseAttempted} attempted,{" "}
                    {coverage.lighthouseSucceeded} succeeded,{" "}
                    {coverage.lighthouseFailed} failed.
                  </p>
                  {coverage.stopReasons.length > 0 && (
                    <p role="status">
                      Stopped or limited:{" "}
                      {coverage.stopReasons
                        .map((reason) => reason.replaceAll("_", " "))
                        .join("; ")}
                      .
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    Complete coverage means the discovered eligible work within
                    this run’s scope was assessed. It does not cover
                    undiscovered URLs.
                  </p>
                </div>
              </>
            );
          }}
        </QueryState>
        <AuditComparison projectId={projectId} auditId={auditId} />
      </CardContent>
    </Card>
  );
}
