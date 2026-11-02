import { useState } from "react";
import { Checkbox } from "@/client/components/ui/checkbox";
import { Button } from "@/client/components/ui/button";
import type {
  AuditScheduleEstimateInput,
  AuditScheduleEstimate,
} from "@/types/schemas/audit-schedule";

export function AuditScheduleReview({
  review,
  canManage,
  busy,
  paidSelected,
  onSave,
}: {
  review: {
    input: AuditScheduleEstimateInput;
    estimate: AuditScheduleEstimate;
  };
  canManage: boolean;
  busy: boolean;
  paidSelected: boolean;
  onSave: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  return (
    <div
      className="rounded-lg border bg-muted/20 p-4 space-y-3"
      aria-label="Schedule review"
    >
      <h3 className="font-medium">
        Review limits and the next three occurrences
      </h3>
      <p className="text-sm break-all">
        {review.input.startUrl} · {review.input.cadence} ·{" "}
        {review.input.timeZone}
      </p>
      <p className="text-sm">
        Up to {review.estimate.maxPagesPerRun} pages/run (current plan ceiling:{" "}
        {review.estimate.pageLimitPerRun}); {review.estimate.maxPagesPerUtcDay}{" "}
        pages and {review.estimate.maxRunsPerUtcDay} runs per UTC day.
        Organization concurrency limit: {review.estimate.maxConcurrentRuns}.
      </p>
      <p className="text-sm">
        Paid cost ceilings: {review.estimate.maxCostMicrosPerRun} micro-USD/run,{" "}
        {review.estimate.maxCostMicrosPerUtcDay} micro-USD/UTC day. Plain HTTP
        uses no paid rendering or Lighthouse units; infrastructure still has
        page/run limits.
      </p>
      <ol className="space-y-2 text-sm">
        {review.estimate.nextOccurrences.map((ms) => (
          <li key={ms}>
            {new Date(ms).toLocaleString(undefined, {
              timeZone: review.input.timeZone,
            })}{" "}
            ({review.input.timeZone})
            <span className="block text-xs text-muted-foreground">
              {new Date(ms).toISOString()} UTC
            </span>
          </li>
        ))}
      </ol>
      {canManage && (
        <>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={reviewed}
              onCheckedChange={(checked) => setReviewed(checked)}
            />
            <span>
              I reviewed this target, timezone, next occurrences and limits.
            </span>
          </label>
          <Button
            disabled={
              !reviewed ||
              busy ||
              paidSelected ||
              (review.input.state === "enabled" &&
                review.estimate.blockedReasons.length > 0)
            }
            pending={busy}
            onClick={onSave}
          >
            {review.input.state === "enabled"
              ? "Enable reviewed schedule"
              : "Save paused schedule"}
          </Button>
        </>
      )}
    </div>
  );
}
