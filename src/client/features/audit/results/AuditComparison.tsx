import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAuditHistory } from "@/serverFunctions/audit";
import { QueryState } from "@/client/components/QueryState";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/client/components/ui/select";
import { Label } from "@/client/components/ui/label";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/client/components/ui/table";
import { auditComparisonQuery } from "./auditEvidenceQueries";

export function AuditComparison({
  projectId,
  auditId,
}: {
  projectId: string;
  auditId: string;
}) {
  const [baselineAuditId, setBaselineAuditId] = useState("");
  const history = useQuery({
    queryKey: ["audit-history", projectId],
    queryFn: () => getAuditHistory({ data: { projectId } }),
  });
  const comparison = useQuery(
    auditComparisonQuery(projectId, auditId, baselineAuditId),
  );
  return (
    <section aria-label="Compare evidence" className="border-t pt-5 space-y-3">
      <h3 className="font-medium">Compare evidence</h3>
      <p className="text-sm text-muted-foreground">
        Choose a baseline explicitly. Only compatible configurations and pages
        successfully assessed by both runs can be compared.
      </p>
      <QueryState
        query={history}
        errorFallback="Could not load comparison choices"
      >
        {(runs) => (
          <>
            <Label htmlFor="audit-baseline">Baseline audit</Label>
            <Select
              value={baselineAuditId}
              onValueChange={(value) => setBaselineAuditId(value ?? "")}
            >
              <SelectTrigger id="audit-baseline" className="w-full sm:max-w-lg">
                <SelectValue placeholder="Choose a saved audit" />
              </SelectTrigger>
              <SelectContent>
                {runs
                  .filter(
                    (run) => run.id !== auditId && run.status !== "running",
                  )
                  .map((run) => (
                    <SelectItem value={run.id} key={run.id}>
                      {new Date(run.startedAt).toLocaleString()} · {run.status}{" "}
                      · {run.id.slice(0, 8)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {runs.filter(
              (run) => run.id !== auditId && run.status !== "running",
            ).length === 0 && (
              <p className="text-sm text-muted-foreground">
                No other finished audit is available yet.
              </p>
            )}
          </>
        )}
      </QueryState>
      {baselineAuditId && (
        <QueryState
          query={comparison}
          errorFallback="Could not compare these audits"
        >
          {(result) => (
            <>
              {!result.comparable ? (
                <p role="status" className="text-sm">
                  Not directly comparable:{" "}
                  {result.reason === "result_persistence_uncertain"
                    ? "An audit did not finish saving its findings"
                    : (result.reason?.replaceAll("_", " ") ??
                      "Unknown coverage")}
                  . No improvement is inferred.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    Matched assessed cohort: {result.matchedPages} pages.
                    Baseline assessed:{" "}
                    {result.baseline.manifest?.coverage.assessed ?? "Unknown"} /
                    discovered at least{" "}
                    {result.baseline.manifest?.coverage.discoveredLowerBound ??
                      "Unknown"}
                    ; current assessed:{" "}
                    {result.current.manifest?.coverage.assessed ?? "Unknown"} /
                    discovered at least{" "}
                    {result.current.manifest?.coverage.discoveredLowerBound ??
                      "Unknown"}
                    .
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Issue in matched cohort</TableHead>
                        <TableHead>Baseline</TableHead>
                        <TableHead>Current</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.issues.map((issue) => (
                        <TableRow key={issue.issueType}>
                          <TableCell>{issue.issueType}</TableCell>
                          <TableCell>{issue.baseline}</TableCell>
                          <TableCell>{issue.current}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {result.crossPageIssueReason && (
                    <p role="status" className="text-sm">
                      Cross-page findings:{" "}
                      {result.crossPageIssueReason.replaceAll("_", " ")}.
                    </p>
                  )}
                  <p className="text-sm">
                    Matched Lighthouse URL/device checks:{" "}
                    {result.matchedLighthouseChecks}. Unmatched or missing
                    checks remain unknown.
                  </p>
                  {result.lighthouse.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>URL / device</TableHead>
                          <TableHead>Baseline performance</TableHead>
                          <TableHead>Current performance</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.lighthouse.map((row) => (
                          <TableRow key={`${row.url}:${row.strategy}`}>
                            <TableCell className="break-all whitespace-normal">
                              {row.url} · {row.strategy}
                            </TableCell>
                            <TableCell>
                              {row.baseline.performanceScore ?? "Unknown"}
                            </TableCell>
                            <TableCell>
                              {row.current.performanceScore ?? "Unknown"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  <p className="text-sm text-muted-foreground">
                    Entered: {result.enteredUrls.length} · exited:{" "}
                    {result.exitedUrls.length} · unassessed:{" "}
                    {result.unassessedUrls.length}. Missing, blocked or
                    unassessed pages are not resolved findings.
                  </p>
                  {[
                    ["Entered URLs", result.enteredUrls],
                    ["Exited URLs", result.exitedUrls],
                    ["Unassessed URLs", result.unassessedUrls],
                  ].map(
                    ([label, urls]) =>
                      typeof urls !== "string" &&
                      urls.length > 0 && (
                        <details key={String(label)} className="text-sm">
                          <summary>{label}</summary>
                          <ul className="break-all list-disc pl-5">
                            {urls.map((url) => (
                              <li key={url}>{url}</li>
                            ))}
                          </ul>
                        </details>
                      ),
                  )}
                </>
              )}
            </>
          )}
        </QueryState>
      )}
    </section>
  );
}
