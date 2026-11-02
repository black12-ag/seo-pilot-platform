import { useForm } from "@tanstack/react-form";
import { Field, FieldLabel } from "@/client/components/ui/field";
import { Input } from "@/client/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/client/components/ui/select";
import { DEFAULT_AUDIT_PAGES, MIN_AUDIT_PAGES } from "@/shared/audit-limits";
import type { AuditScheduleEstimateInput } from "@/types/schemas/audit-schedule";

type ScheduleDraft = Omit<
  AuditScheduleEstimateInput,
  "projectId" | "weekday"
> & { weekday: number };

export function useAuditScheduleForm(
  settings: AuditScheduleEstimateInput | undefined,
  initialUrl: string,
  onReview: (value: ScheduleDraft) => void,
) {
  const defaultValues: ScheduleDraft = {
    startUrl: settings?.startUrl ?? initialUrl,
    cadence: settings?.cadence ?? "daily",
    timeZone:
      settings?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour: settings?.hour ?? 8,
    minute: settings?.minute ?? 0,
    weekday: settings?.cadence === "weekly" ? settings.weekday : 1,
    maxPages: settings?.maxPages ?? DEFAULT_AUDIT_PAGES,
    maxPagesPerUtcDay: settings?.maxPagesPerUtcDay ?? DEFAULT_AUDIT_PAGES,
    maxRunsPerUtcDay: settings?.maxRunsPerUtcDay ?? 1,
    maxCostMicrosPerRun: settings?.maxCostMicrosPerRun ?? 0,
    maxCostMicrosPerUtcDay: settings?.maxCostMicrosPerUtcDay ?? 0,
    renderJavaScript: settings?.renderJavaScript ?? false,
    lighthouseStrategy: settings?.lighthouseStrategy ?? "none",
    state: "paused" as "paused" | "enabled",
  };
  return useForm({ defaultValues, onSubmit: ({ value }) => onReview(value) });
}

export function AuditScheduleFields({
  form,
  values,
  canManage,
  busy,
  schedule,
}: {
  form: ReturnType<typeof useAuditScheduleForm>;
  values: ScheduleDraft;
  canManage: boolean;
  busy: boolean;
  schedule: boolean;
}) {
  return (
    <fieldset
      disabled={!canManage || busy}
      className="grid gap-5 sm:grid-cols-2"
    >
      <form.Field name="startUrl">
        {(field) => (
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="recurring-target">Target URL</FieldLabel>
            <Input
              id="recurring-target"
              type="url"
              required
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="cadence">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="recurring-cadence">Cadence</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                if (value === "daily" || value === "weekly")
                  field.handleChange(value);
              }}
            >
              <SelectTrigger id="recurring-cadence">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field name="timeZone">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="recurring-timezone">IANA timezone</FieldLabel>
            <Input
              id="recurring-timezone"
              required
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      {(
        [
          ["hour", "Local hour (0–23)", 0, 23],
          ["minute", "Local minute (0–59)", 0, 59],
          ...(values.cadence === "weekly"
            ? [["weekday", "Weekday (0 Sunday–6 Saturday)", 0, 6] as const]
            : []),
          ["maxPages", "Maximum pages per run", MIN_AUDIT_PAGES, undefined],
          [
            "maxPagesPerUtcDay",
            "Maximum pages per UTC day",
            MIN_AUDIT_PAGES,
            undefined,
          ],
          ["maxRunsPerUtcDay", "Maximum runs per UTC day", 1, undefined],
          [
            "maxCostMicrosPerRun",
            "Cost ceiling per run (micro-USD)",
            0,
            undefined,
          ],
          [
            "maxCostMicrosPerUtcDay",
            "Cost ceiling per UTC day (micro-USD)",
            0,
            undefined,
          ],
        ] as const
      ).map(([name, label, min, max]) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`recurring-${name}`}>{label}</FieldLabel>
              <Input
                id={`recurring-${name}`}
                type="number"
                required
                min={min}
                max={max}
                step={1}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) =>
                  field.handleChange(event.target.valueAsNumber)
                }
              />
            </Field>
          )}
        </form.Field>
      ))}
      <form.Field name="renderJavaScript">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="recurring-render">
              JavaScript rendering
            </FieldLabel>
            <Select
              value={field.state.value ? "on" : "off"}
              onValueChange={(value) => field.handleChange(value === "on")}
            >
              <SelectTrigger id="recurring-render">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off · plain HTTP</SelectItem>
                <SelectItem value="on">
                  On · unavailable for recurrence
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field name="lighthouseStrategy">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="recurring-lighthouse">Lighthouse</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                if (value === "none" || value === "auto")
                  field.handleChange(value);
              }}
            >
              <SelectTrigger id="recurring-lighthouse">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="auto">
                  Auto · unavailable for recurrence
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      {canManage && (
        <form.Field name="state">
          {(field) => (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="recurring-intent">After review</FieldLabel>
              <Select
                value={field.state.value}
                onValueChange={(value) => {
                  if (value === "paused" || value === "enabled")
                    field.handleChange(value);
                }}
              >
                <SelectTrigger id="recurring-intent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paused">Save paused</SelectItem>
                  <SelectItem value="enabled" disabled={!schedule}>
                    Enable for the next occurrence
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
      )}
    </fieldset>
  );
}
