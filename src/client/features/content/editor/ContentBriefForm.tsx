import { revalidateLogic } from "@tanstack/react-form";
import { z } from "zod";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Button } from "@/client/components/ui/button";
import { contentBriefSchema, type ContentBrief } from "@/types/schemas/content";

const formSchema = contentBriefSchema
  .omit({ freshnessMaxAgeDays: true })
  .extend({
    freshnessMaxAgeDays: z
      .string()
      .refine(
        (value) => value === "" || /^(?:[1-9]|[12][0-9]|30)$/.test(value),
        "Use a whole number from 1 to 30 days.",
      ),
  });

export function ContentBriefForm({
  initialBrief,
  onSubmit,
  onDirtyChange,
  submitLabel = "Save brief",
}: {
  initialBrief: ContentBrief;
  onSubmit: (brief: ContentBrief) => Promise<void | boolean>;
  onDirtyChange?: (dirty: boolean) => void;
  submitLabel?: string;
}) {
  const form = useAppForm({
    defaultValues: {
      ...initialBrief,
      freshnessMaxAgeDays: initialBrief.freshnessMaxAgeDays?.toString() ?? "",
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: formSchema },
    listeners: { onChange: () => onDirtyChange?.(true) },
    onSubmit: async ({ value }) => {
      const applied = await onSubmit({
        ...value,
        freshnessMaxAgeDays: value.freshnessMaxAgeDays
          ? Number(value.freshnessMaxAgeDays)
          : undefined,
      });
      if (applied === false) return;
      if (JSON.stringify(form.state.values) === JSON.stringify(value)) {
        form.reset(value);
        onDirtyChange?.(false);
      }
    },
  });

  return (
    <form.AppForm>
      <form.Form className="space-y-4">
        <form.AppField name="topic">
          {(field) => <field.TextField label="Topic or keyword" required />}
        </form.AppField>
        <form.AppField name="target">
          {(field) => <field.TextField label="Target page or domain" />}
        </form.AppField>
        <form.AppField name="objective">
          {(field) => <field.TextareaField label="Objective" />}
        </form.AppField>
        <form.AppField name="audience">
          {(field) => <field.TextareaField label="Audience" />}
        </form.AppField>
        <form.AppField name="outputKind">
          {(field) => <field.TextField label="Output kind" required />}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="locale.language">
            {(field) => <field.TextField label="Language" required />}
          </form.AppField>
          <form.AppField name="locale.country">
            {(field) => <field.TextField label="Country" required />}
          </form.AppField>
        </div>
        <form.AppField name="freshnessMaxAgeDays">
          {(field) => (
            <field.TextField
              label="Maximum source age in days (optional)"
              description="Use 1–30 to set a stricter limit. Sensitive claims still use their shorter default."
              inputMode="numeric"
            />
          )}
        </form.AppField>
        <form.SubmitButton>{submitLabel}</form.SubmitButton>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            form.reset();
            onDirtyChange?.(false);
          }}
        >
          Discard brief changes
        </Button>
      </form.Form>
    </form.AppForm>
  );
}
