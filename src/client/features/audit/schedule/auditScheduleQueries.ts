import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";
import {
  getAuditSchedule,
  listAuditAttempts,
} from "@/serverFunctions/audit-schedule";

export const auditScheduleQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["audit-schedule", projectId],
    queryFn: () => getAuditSchedule({ data: { projectId } }),
    refetchInterval: (query) =>
      query.state.data?.schedule?.settings.state === "enabled" ||
      (query.state.data?.usage.outstandingRuns ?? 0) > 0
        ? 15_000
        : false,
  });

export const auditAttemptsQuery = (projectId: string) =>
  infiniteQueryOptions({
    queryKey: ["audit-attempts", projectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listAuditAttempts({ data: { projectId, cursor: pageParam, limit: 25 } }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Read-only refresh discovers newly admitted attempts while this screen stays open.
    refetchInterval: 15_000,
  });
