import {
  AuditScheduleFields,
  useAuditScheduleForm,
} from "./AuditScheduleFields";
import { AuditScheduleReview } from "./AuditScheduleReview";
import { useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
  estimateAuditSchedule,
  saveAuditSchedule,
} from "@/serverFunctions/audit-schedule";
import {
  auditScheduleEstimateInputSchema,
  type AuditScheduleGetResult,
} from "@/types/schemas/audit-schedule";
import { auditScheduleQuery } from "./auditScheduleQueries";

export function AuditScheduleSettings({
  projectId,
  initialUrl,
}: {
  projectId: string;
  initialUrl: string;
}) {
  const query = useQuery(auditScheduleQuery(projectId));
  return (
    <section id="audit-schedule" aria-label="Recurring audits">
      <QueryState
        query={query}
        errorFallback="Could not load the audit schedule"
      >
        {(data) => (
          <ScheduleForm
            key={`${projectId}:${data.schedule?.version ?? 0}:${data.canManage}`}
            projectId={projectId}
            initialUrl={initialUrl}
            data={data}
          />
        )}
      </QueryState>
    </section>
  );
}

function ScheduleForm({
  projectId,
  initialUrl,
  data,
}: {
  projectId: string;
  initialUrl: string;
  data: AuditScheduleGetResult;
}) {
  const queryClient = useQueryClient();
  const schedule = data.schedule;
  const settings = schedule?.settings;
  const form = useAuditScheduleForm(settings, initialUrl, (value) =>
    estimate.mutate(value),
  );
  const values = useStore(form.store, (state) => state.values);
  const estimate = useMutation({
    mutationFn: async (draft: typeof values) => {
      const { weekday, ...rest } = draft;
      const input = auditScheduleEstimateInputSchema.parse({
        ...rest,
        projectId,
        ...(draft.cadence === "weekly" ? { weekday } : {}),
      });
      return {
        draft,
        input,
        estimate: await estimateAuditSchedule({ data: input }),
      };
    },
  });
  const save = useMutation({
    mutationFn: saveAuditSchedule,
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: auditScheduleQuery(projectId).queryKey,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(auditScheduleQuery(projectId).queryKey, result);
      void queryClient.invalidateQueries({
        queryKey: ["audit-attempts", projectId],
      });
      toast.success(
        result.schedule?.state === "enabled"
          ? "Schedule enabled for the next occurrence"
          : result.schedule?.state === "blocked"
            ? "Schedule saved; execution is blocked"
            : "Schedule saved paused",
      );
    },
  });
  const pause = useMutation({
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: auditScheduleQuery(projectId).queryKey,
      }),
    mutationFn: async () => {
      if (!schedule) return;
      const input = { ...schedule.settings, state: "paused" as const };
      const review = await estimateAuditSchedule({ data: input });
      return saveAuditSchedule({
        data: {
          ...input,
          expectedVersion: schedule.version,
          estimateFingerprint: review.estimateFingerprint,
        },
      });
    },
    onSuccess: (result) => {
      if (result)
        queryClient.setQueryData(
          auditScheduleQuery(projectId).queryKey,
          result,
        );
      void queryClient.invalidateQueries({
        queryKey: ["audit-attempts", projectId],
      });
      toast.success("Future scheduled audits paused");
    },
  });
  const review =
    estimate.data &&
    JSON.stringify(estimate.data.draft) === JSON.stringify(values)
      ? estimate.data
      : null;
  const busy = estimate.isPending || save.isPending || pause.isPending;
  const blockedReasons = [
    ...new Set([
      ...(schedule?.blockedReasons ?? []),
      ...(review?.estimate.blockedReasons ?? []),
    ]),
  ];
  const paidSelected =
    values.renderJavaScript || values.lighthouseStrategy !== "none";

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>
            <h2>Recurring audits</h2>
          </CardTitle>
          <Badge variant="secondary">
            {schedule?.state ?? "Off by default"}
          </Badge>
        </div>
        <CardDescription>
          Choose when to collect public-site evidence and the limits for each
          run. Saving never starts an immediate audit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!data.canManage && (
          <p className="text-sm text-muted-foreground">
            Only the current workspace owner can change this schedule. You can
            read its settings and evidence.
          </p>
        )}
        {!data.backgroundAuthoritySupported && (
          <p role="status" className="text-sm">
            Recurring audits are blocked: this sign-in mode cannot verify
            background authority.
          </p>
        )}
        {blockedReasons.length > 0 && (
          <div role="status" className="rounded-md border p-3 text-sm">
            Blocked:{" "}
            {blockedReasons
              .map((reason) => reason.replaceAll("_", " "))
              .join("; ")}
            .
          </div>
        )}
        {schedule?.nextDueAtMs != null && (
          <p className="text-sm">
            Next observation:{" "}
            {new Date(schedule.nextDueAtMs).toLocaleString(undefined, {
              timeZone: schedule.settings.timeZone,
            })}{" "}
            ({schedule.settings.timeZone}) ·{" "}
            {new Date(schedule.nextDueAtMs).toISOString()} UTC
          </p>
        )}
        <div
          className="rounded-md border p-3 space-y-2 text-sm"
          aria-label="Organization recurring usage"
        >
          <h3 className="font-medium">
            Organization usage · {data.usage.utcDay} UTC
          </h3>
          <p>
            Runs: {data.usage.consumedRuns} used, {data.usage.reservedRuns}{" "}
            reserved. Page allowance: {data.usage.consumedPages} used,{" "}
            {data.usage.reservedPages} reserved.
          </p>
          <p>
            Cost allowance: {data.usage.consumedCostMicros} micro-USD used,{" "}
            {data.usage.reservedCostMicros} micro-USD reserved. Outstanding runs
            across all days: {data.usage.outstandingRuns}; uncertain runs:{" "}
            {data.usage.unknownRuns}.
          </p>
          <p className="text-xs text-muted-foreground">
            Page allowance may include conservative upper bounds; observed page
            counts are in each audit’s evidence. Read at{" "}
            {new Date(data.usage.observedAtMs).toLocaleString()}.
          </p>
        </div>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <p className="text-xs text-muted-foreground">
            Current plan ceiling: {data.pageLimitPerRun} pages per run. Review
            your requested limits below; a request above this ceiling is
            blocked.
          </p>
          <AuditScheduleFields
            form={form}
            values={values}
            canManage={data.canManage}
            busy={busy}
            schedule={Boolean(schedule)}
          />
          <p
            role={paidSelected ? "alert" : undefined}
            className="rounded-md bg-muted/40 border p-3 text-sm"
          >
            Rendering and Lighthouse recurrence are unavailable in this release.
            Plain HTTP recurrence requires both to be off and paid cost ceilings
            to be zero. Requested paid options are refused, never silently
            changed. Manual audit options remain available above.
          </p>
          {data.canManage && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                pending={estimate.isPending}
                disabled={busy}
              >
                Review schedule
              </Button>
              {schedule?.settings.state === "enabled" && (
                <Button
                  type="button"
                  variant="outline"
                  pending={pause.isPending}
                  disabled={busy}
                  onClick={() => pause.mutate()}
                >
                  Pause future audits
                </Button>
              )}
            </div>
          )}
        </form>
        {review && (
          <AuditScheduleReview
            key={`${review.estimate.estimateFingerprint}:${estimate.submittedAt}`}
            review={review}
            canManage={data.canManage}
            busy={busy}
            paidSelected={paidSelected}
            onSave={() =>
              save.mutate({
                data: {
                  ...review.input,
                  expectedVersion: schedule?.version ?? 0,
                  estimateFingerprint: review.estimate.estimateFingerprint,
                },
              })
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
