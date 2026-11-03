import { useState } from "react";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Button } from "@/client/components/ui/button";
import {
  CONTENT_CLAIM_LIMIT,
  CONTENT_CLAIM_EVIDENCE_LIMIT,
  contentClaimInputSchema,
  type ContentClaimInput,
} from "@/types/schemas/contentEvidence";
import type { ContentMetadata } from "@/types/schemas/content";

import { ClaimList, type Source } from "./ContentClaimList";

type Target = "markdown" | keyof ContentMetadata;
type Kind = ContentClaimInput["kind"];
type Relation = ContentClaimInput["evidence"][number]["relation"];

export function ContentClaimPanel({
  markdown,
  metadata,
  sources,
  claims,
  onChange,
  onDirtyChange,
}: {
  markdown: string;
  metadata: ContentMetadata;
  sources: Source[];
  claims: ContentClaimInput[];
  onChange: (claims: ContentClaimInput[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<number | null>(null);
  const form = useAppForm({
    defaultValues: {
      target: "markdown" as Target,
      text: "",
      start: "",
      kind: "general" as Kind,
      factual: true,
      sourceId: "",
      excerpt: "",
      excerptStart: "",
      relation: "supports" as Relation,
    },
    listeners: { onChange: () => onDirtyChange?.(true) },
    onSubmit: ({ value }) => {
      const targetText =
        value.target === "markdown" ? markdown : metadata[value.target];
      const start = value.start.trim()
        ? Number(value.start)
        : targetText.indexOf(value.text);
      const source = sources.find((item) => item.id === value.sourceId);
      const excerptStart = value.excerptStart.trim()
        ? Number(value.excerptStart)
        : (source?.text.indexOf(value.excerpt) ?? -1);
      if (
        evidenceFor === null &&
        (!value.text ||
          (value.target === "markdown"
            ? !Number.isSafeInteger(start) ||
              start < 0 ||
              targetText.slice(start, start + value.text.length) !== value.text
            : targetText !== value.text))
      ) {
        setError(
          "Body claims must match at the offset; metadata claims must match the entire field.",
        );
        return;
      }
      if (
        (value.sourceId || evidenceFor !== null) &&
        (!source ||
          !value.excerpt ||
          !Number.isSafeInteger(excerptStart) ||
          excerptStart < 0 ||
          source.text.slice(
            excerptStart,
            excerptStart + value.excerpt.length,
          ) !== value.excerpt)
      ) {
        setError(
          "The excerpt must match the selected source at the given character offset.",
        );
        return;
      }
      const claimKind =
        evidenceFor === null ? value.kind : claims[evidenceFor]?.kind;
      if (
        source?.kind === "audit" &&
        value.relation === "supports" &&
        claimKind &&
        ["product", "security", "financial", "legal"].includes(claimKind)
      ) {
        setError(
          "An audit observation cannot support a sensitive claim. Use attributed source text, or mark the observation as background or contradiction.",
        );
        return;
      }
      if (evidenceFor !== null) {
        const claim = claims[evidenceFor];
        if (
          !claim ||
          !source ||
          claim.evidence.length >= CONTENT_CLAIM_EVIDENCE_LIMIT
        ) {
          setError("Choose a source and keep at most 10 passages per claim.");
          return;
        }
        const evidence = {
          sourceId: source.id,
          start: excerptStart,
          end: excerptStart + value.excerpt.length,
          excerpt: value.excerpt,
          relation: value.relation,
        };
        onChange(
          claims.map((item, index) =>
            index === evidenceFor
              ? { ...item, evidence: [...item.evidence, evidence] }
              : item,
          ),
        );
        setEvidenceFor(null);
        setError(null);
        form.reset();
        onDirtyChange?.(false);
        return;
      }
      const candidate = {
        target:
          value.target === "markdown"
            ? {
                kind: "markdown" as const,
                start,
                end: start + value.text.length,
              }
            : { kind: "metadata" as const, field: value.target },
        text: value.text,
        kind: value.kind,
        factual: value.factual,
        evidence: source
          ? [
              {
                sourceId: source.id,
                start: excerptStart,
                end: excerptStart + value.excerpt.length,
                excerpt: value.excerpt,
                relation: value.relation,
              },
            ]
          : [],
      };
      const parsed = contentClaimInputSchema.safeParse(candidate);
      if (!parsed.success || claims.length >= CONTENT_CLAIM_LIMIT) {
        setError("Check the claim and source limits before adding it.");
        return;
      }
      onChange([...claims, parsed.data]);
      setError(null);
      form.reset();
      onDirtyChange?.(false);
    },
  });
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">Claims and evidence</h2>
      <p className="text-muted-foreground text-sm">
        Paste exact text from the draft and its sources. A source does not by
        itself prove a claim. Up to {CONTENT_CLAIM_LIMIT} claims and{" "}
        {CONTENT_CLAIM_EVIDENCE_LIMIT} passages per claim.
      </p>
      {sources.map((source) => (
        <details key={source.id} className="rounded border p-3 text-sm">
          <summary className="cursor-pointer break-all">
            {source.title}
            {source.kind === "audit"
              ? " · typed audit observation (not a page quotation)"
              : source.kind === "web"
                ? " · public URL extraction"
                : " · attributed text"}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">
            {source.text}
          </pre>
        </details>
      ))}
      <ClaimList
        claims={claims}
        markdown={markdown}
        sources={sources}
        onChange={onChange}
        onAdd={(index) => {
          setEvidenceFor(index);
          setError(null);
        }}
        onRemove={() => setEvidenceFor(null)}
      />
      <form.AppForm>
        <form.Form className="space-y-3">
          {evidenceFor === null ? (
            <>
              <form.AppField name="target">
                {(field) => (
                  <field.SelectField
                    label="Claim field"
                    items={[
                      { value: "markdown", label: "Body" },
                      { value: "title", label: "Title" },
                      { value: "slug", label: "Slug" },
                      { value: "description", label: "Description" },
                      { value: "schemaSuggestion", label: "Schema suggestion" },
                    ]}
                  />
                )}
              </form.AppField>
              <form.AppField name="text">
                {(field) => (
                  <field.TextareaField label="Exact claim text" required />
                )}
              </form.AppField>
              <details>
                <summary className="cursor-pointer text-sm">
                  Advanced claim placement
                </summary>
                <p className="text-muted-foreground text-sm">
                  Repeated text uses the first match unless you enter a UTF-16
                  offset.
                </p>
                <form.AppField name="start">
                  {(field) => (
                    <field.TextField
                      label="Claim start offset (optional)"
                      inputMode="numeric"
                    />
                  )}
                </form.AppField>
              </details>
              <form.AppField name="kind">
                {(field) => (
                  <field.SelectField
                    label="Claim kind"
                    items={(
                      [
                        "general",
                        "product",
                        "security",
                        "financial",
                        "legal",
                        "opinion",
                      ] as const
                    ).map((kind) => ({ value: kind, label: kind }))}
                  />
                )}
              </form.AppField>
              <form.AppField name="factual">
                {(field) => (
                  <field.CheckboxField label="This claim asserts a fact" />
                )}
              </form.AppField>
            </>
          ) : (
            <p className="text-sm">
              Adding evidence to: {claims[evidenceFor]?.text}
            </p>
          )}
          <form.AppField name="sourceId">
            {(field) => (
              <field.SelectField
                label="Evidence source (optional)"
                items={[
                  { value: "", label: "No source" },
                  ...sources.map((source) => ({
                    value: source.id,
                    label: source.title,
                  })),
                ]}
              />
            )}
          </form.AppField>
          <form.AppField name="excerpt">
            {(field) => <field.TextareaField label="Exact source excerpt" />}
          </form.AppField>
          <details>
            <summary className="cursor-pointer text-sm">
              Advanced excerpt placement
            </summary>
            <p className="text-muted-foreground text-sm">
              Repeated text uses the first match unless you enter a UTF-16
              offset.
            </p>
            <form.AppField name="excerptStart">
              {(field) => (
                <field.TextField
                  label="Excerpt start offset (optional)"
                  inputMode="numeric"
                />
              )}
            </form.AppField>
          </details>
          <form.AppField name="relation">
            {(field) => (
              <field.SelectField
                label="Evidence relation"
                items={(["supports", "contradicts", "background"] as const).map(
                  (relation) => ({ value: relation, label: relation }),
                )}
              />
            )}
          </form.AppField>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <form.SubmitButton>
            {evidenceFor === null ? "Add claim" : "Add passage"}
          </form.SubmitButton>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setEvidenceFor(null);
              setError(null);
              form.reset();
              onDirtyChange?.(false);
            }}
          >
            Discard entry
          </Button>
        </form.Form>
      </form.AppForm>
    </section>
  );
}
