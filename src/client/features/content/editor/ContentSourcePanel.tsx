import { revalidateLogic } from "@tanstack/react-form";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Button } from "@/client/components/ui/button";
import { getAuditHistory } from "@/serverFunctions/audit";
import {
  contentSourceInputSchema,
  type ContentSourceInput,
} from "@/types/schemas/contentEvidence";

const pastedSourceSchema = contentSourceInputSchema.options[0].extend({
  publisherDate: z.string().max(50),
  language: z.string().max(50),
  market: z.string().max(100),
});

export function ContentSourcePanel({
  projectId,
  onCapture,
  onDirtyChange,
}: {
  projectId: string;
  onCapture: (source: ContentSourceInput) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [pasteDirty, setPasteDirty] = useState(false);
  const [auditDirty, setAuditDirty] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  async function capture(source: ContentSourceInput) {
    setCaptureError(null);
    try {
      await onCapture(source);
      return true;
    } catch (error) {
      setCaptureError(
        error instanceof Error ? error.message : "Could not capture source.",
      );
      return false;
    }
  }
  useEffect(
    () => onDirtyChange?.(pasteDirty || auditDirty),
    [pasteDirty, auditDirty, onDirtyChange],
  );
  const history = useQuery({
    queryKey: ["audit-history", projectId],
    queryFn: () => getAuditHistory({ data: { projectId } }),
  });
  const form = useAppForm({
    defaultValues: {
      kind: "pasted" as const,
      title: "",
      attribution: "",
      text: "",
      publisherDate: "",
      language: "",
      market: "",
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: pastedSourceSchema },
    listeners: { onChange: () => setPasteDirty(true) },
    onSubmit: async ({ value }) => {
      if (
        !(await capture({
          ...value,
          publisherDate: value.publisherDate || null,
          language: value.language || null,
          market: value.market || null,
        }))
      )
        return;
      if (JSON.stringify(form.state.values) === JSON.stringify(value)) {
        form.reset();
        setPasteDirty(false);
      }
    },
  });
  const auditForm = useAppForm({
    defaultValues: { auditId: "", pageId: "", issueId: "" },
    validators: {
      onSubmit: z.object({
        auditId: z.string().min(1).max(255),
        pageId: z.string().max(255),
        issueId: z.string().max(255),
      }),
    },
    listeners: { onChange: () => setAuditDirty(true) },
    onSubmit: async ({ value }) => {
      if (
        !(await capture({
          kind: "audit",
          auditId: value.auditId,
          pageId: value.pageId || null,
          issueId: value.issueId || null,
        }))
      )
        return;
      if (JSON.stringify(auditForm.state.values) === JSON.stringify(value)) {
        auditForm.reset();
        setAuditDirty(false);
      }
    },
  });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Add a source</h2>
      <p className="text-muted-foreground text-sm">
        Paste an attributed source. Captures are saved separately from the
        draft.
      </p>
      {captureError ? (
        <p role="alert" className="text-destructive text-sm">
          {captureError} Your entry is still here.
        </p>
      ) : null}
      <form.AppForm>
        <form.Form className="space-y-3">
          <form.AppField name="title">
            {(field) => <field.TextField label="Source title" required />}
          </form.AppField>
          <form.AppField name="attribution">
            {(field) => <field.TextField label="Attribution" required />}
          </form.AppField>
          <form.AppField name="text">
            {(field) => (
              <field.TextareaField
                label="Source text"
                description="Up to 100 KB UTF-8. Include only material you can use."
              />
            )}
          </form.AppField>
          <form.AppField name="publisherDate">
            {(field) => <field.TextField label="Publisher date (optional)" />}
          </form.AppField>
          <div className="grid gap-3 sm:grid-cols-2">
            <form.AppField name="language">
              {(field) => (
                <field.TextField label="Source language (optional)" />
              )}
            </form.AppField>
            <form.AppField name="market">
              {(field) => <field.TextField label="Source market (optional)" />}
            </form.AppField>
          </div>
          <form.SubmitButton>Capture source</form.SubmitButton>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              form.reset();
              setPasteDirty(false);
            }}
          >
            Discard source entry
          </Button>
        </form.Form>
      </form.AppForm>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Attach audit evidence
        </summary>
        <p className="text-muted-foreground text-sm">
          An audit capture is a typed observation, not a page-body quotation.
          Sensitive claims need attributed source text for support.
        </p>
        <auditForm.AppForm>
          <auditForm.Form className="mt-3 space-y-3">
            <auditForm.AppField name="auditId">
              {(field) => (
                <field.SelectField
                  label="Saved audit"
                  disabled={!history.data?.length}
                  items={(history.data ?? []).map((audit) => ({
                    value: audit.id,
                    label: `${new Date(audit.startedAt).toLocaleDateString()} · ${audit.startUrl} · ${audit.status} · ${audit.pagesCrawled} pages crawled`,
                  }))}
                />
              )}
            </auditForm.AppField>
            {history.isPending ? <p>Loading audits…</p> : null}
            {history.isError ? <p>Could not load audit history.</p> : null}
            {history.data?.length === 0 ? <p>No saved audits.</p> : null}
            <auditForm.AppField name="pageId">
              {(field) => <field.TextField label="Page ID (optional)" />}
            </auditForm.AppField>
            <auditForm.AppField name="issueId">
              {(field) => <field.TextField label="Issue ID (optional)" />}
            </auditForm.AppField>
            <auditForm.SubmitButton>
              Attach audit evidence
            </auditForm.SubmitButton>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                auditForm.reset();
                setAuditDirty(false);
              }}
            >
              Discard audit entry
            </Button>
          </auditForm.Form>
        </auditForm.AppForm>
      </details>
    </section>
  );
}
