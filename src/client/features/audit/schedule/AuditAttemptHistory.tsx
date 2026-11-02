import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { QueryState } from "@/client/components/QueryState";
import { Button } from "@/client/components/ui/button";
import { Badge } from "@/client/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/client/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { auditAttemptsQuery } from "./auditScheduleQueries";

export function AuditAttemptHistory({ projectId }: { projectId: string }) {
  const query = useInfiniteQuery(auditAttemptsQuery(projectId));
  return (
    <Card id="audit-attempts">
      <CardHeader>
        <CardTitle>
          <h2>Recurring attempt history</h2>
        </CardTitle>
        <CardDescription>
          Launch, coverage and billing are independent. A completed launch does
          not mean every page was assessed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState
          query={query}
          errorFallback="Could not load recurring attempts"
        >
          {(data) => (
            <>
              {data.pages[0].attempts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No recurring audit attempts yet. Enabling schedules the next
                  occurrence; it does not run immediately.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        "Scheduled slot",
                        "Launch",
                        "Coverage",
                        "Billing",
                        "Evidence",
                      ].map((label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.pages
                      .flatMap((page) => page.attempts)
                      .map((attempt) => (
                        <TableRow key={attempt.id}>
                          <TableCell>
                            <div>
                              {new Date(attempt.dueAtMs).toLocaleString()}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {new Date(attempt.dueAtMs).toISOString()} ·
                              revision {attempt.scheduleVersion}
                            </div>
                            {attempt.firstMissedAtMs !==
                              attempt.lastMissedAtMs && (
                              <div className="text-xs">
                                Catch-up:{" "}
                                {attempt.missedCount ?? "count unavailable"}{" "}
                                slots,{" "}
                                {new Date(
                                  attempt.firstMissedAtMs,
                                ).toISOString()}
                                –
                                {new Date(attempt.lastMissedAtMs).toISOString()}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">
                              {attempt.launchState}
                            </Badge>
                            {attempt.reason && (
                              <p className="max-w-64 whitespace-normal text-xs mt-1">
                                {attempt.reason.replaceAll("_", " ")}
                              </p>
                            )}
                            {attempt.retryAtMs && (
                              <p className="text-xs">
                                Retry after{" "}
                                {new Date(attempt.retryAtMs).toLocaleString()}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>{attempt.coverageState}</TableCell>
                          <TableCell>
                            {attempt.billingState.replaceAll("_", " ")}
                          </TableCell>
                          <TableCell>
                            {attempt.resultDeleted ? (
                              "Result deleted"
                            ) : attempt.auditId ? (
                              <Button
                                nativeButton={false}
                                size="sm"
                                variant="outline"
                                render={
                                  <Link
                                    to="/p/$projectId/audit"
                                    params={{ projectId }}
                                    search={{ auditId: attempt.auditId }}
                                  />
                                }
                              >
                                View evidence
                              </Button>
                            ) : (
                              "No result yet"
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
              {query.hasNextPage && (
                <Button
                  className="mt-4"
                  variant="outline"
                  pending={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  Load older attempts
                </Button>
              )}
            </>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}
