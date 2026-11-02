import { useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { Button } from "@/client/components/ui/button";
import type {
  SavedContentRevision,
  SaveContentRevisionInput,
  SaveContentRevisionResult,
} from "@/types/schemas/content";
import type {
  ContentSourceInput,
  SavedContentSource,
} from "@/types/schemas/contentEvidence";
import { ContentBriefForm } from "./ContentBriefForm";
import { ContentEditorFields, ContextRefresh } from "./ContentEditorFields";
import { ContentClaimPanel } from "./ContentClaimPanel";
import { ContentPreview } from "./ContentPreview";
import { ContentEditorSources } from "./ContentEditorSources";

type Draft = Omit<SaveContentRevisionInput, "mutationId">;
export type ContentEditorTab =
  | "write"
  | "sources"
  | "claims"
  | "preview"
  | "brief";

function draftFromRevision(revision: SavedContentRevision): Draft {
  return {
    projectId: revision.projectId,
    contentId: revision.contentId,
    expectedHeadVersion: revision.version,
    expectedContextVersion: revision.contextVersion,
    brief: revision.brief,
    markdown: revision.markdown,
    metadata: revision.metadata,
    sourceIds: revision.sourceIds,
    claims: revision.claims.map(
      ({ target, text, kind, factual, evidence }) => ({
        target,
        text,
        kind,
        factual,
        evidence: evidence.map(
          ({ sourceId, start, end, excerpt, relation }) => ({
            sourceId,
            start,
            end,
            excerpt,
            relation,
          }),
        ),
      }),
    ),
    openQuestions: revision.openQuestions,
    omissions: revision.omissions,
  };
}

export function ContentEditor({
  revision,
  sources,
  unavailableSources,
  currentContextVersion,
  currentContextSnapshot,
  contextReady,
  onLocaleChange,
  archived,
  onArchive,
  restoration,
  onRestoreApplied,
  tab,
  onTabChange,
  onSave,
  onCapture,
}: {
  revision: SavedContentRevision;
  sources: SavedContentSource[];
  unavailableSources: string[];
  currentContextVersion: number;
  currentContextSnapshot: unknown;
  contextReady: boolean;
  onLocaleChange: (locale: SavedContentRevision["brief"]["locale"]) => void;
  archived: boolean;
  onArchive: (expectedHeadVersion: number) => Promise<void>;
  restoration: SavedContentRevision | null;
  onRestoreApplied: () => void;
  tab: ContentEditorTab;
  onTabChange: (tab: ContentEditorTab) => void;
  onSave: (
    input: SaveContentRevisionInput,
  ) => Promise<SaveContentRevisionResult>;
  onCapture: (source: ContentSourceInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFromRevision(revision));
  const [savedContextJson, setSavedContextJson] = useState(
    revision.contextJson,
  );
  const [savedLocale, setSavedLocale] = useState(revision.brief.locale);
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(draftFromRevision(revision)),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [locallyArchived, setLocallyArchived] = useState(false);
  const [briefDirty, setBriefDirty] = useState(false);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [claimDirty, setClaimDirty] = useState(false);
  const [briefKey, setBriefKey] = useState(0);
  const attempt = useRef<{ serialized: string; mutationId: string } | null>(
    null,
  );
  const unsubmitted = briefDirty || sourceDirty || claimDirty;
  const dirty = JSON.stringify(draft) !== baseline || unsubmitted;
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirty &&
      current.pathname !== next.pathname &&
      !window.confirm("Discard unsaved changes?"),
    enableBeforeUnload: dirty,
  });
  async function save() {
    const serialized = JSON.stringify(draft);
    if (attempt.current?.serialized !== serialized) {
      attempt.current = { serialized, mutationId: crypto.randomUUID() };
    }
    setPending(true);
    setError(null);
    try {
      const result = await onSave({
        ...draft,
        mutationId: attempt.current.mutationId,
      });
      if (!result.ok) {
        setError(
          `The saved content changed (current version ${result.currentHeadVersion}). Your draft is still here; review the latest version before saving.`,
        );
        return;
      }
      const saved = draftFromRevision(result.revision);
      setDraft(saved);
      setSavedContextJson(result.revision.contextJson);
      setSavedLocale(result.revision.brief.locale);
      setBaseline(JSON.stringify(saved));
      setBriefKey((key) => key + 1);
      attempt.current = null;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save. Your draft is still here.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <p className="text-muted-foreground text-sm font-medium">
          Revision {draft.expectedHeadVersion} ·{" "}
          {dirty ? "Unsaved changes" : "Saved"}
        </p>
        <Button
          type="button"
          onClick={save}
          disabled={
            pending || !dirty || unsubmitted || archived || locallyArchived
          }
        >
          {pending ? "Saving…" : "Save revision"}
        </Button>
      </div>
      {archived || locallyArchived ? (
        <p className="text-sm">
          This content is archived. Its saved history remains available; new
          saves are disabled.
        </p>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={async () => {
            if (
              !window.confirm(
                dirty
                  ? "Archive this content? Unsaved changes will remain local and cannot be saved while archived."
                  : "Archive this content? Its history will be retained.",
              )
            )
              return;
            setPending(true);
            setError(null);
            try {
              await onArchive(draft.expectedHeadVersion);
              setLocallyArchived(true);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not archive content.",
              );
            } finally {
              setPending(false);
            }
          }}
        >
          Archive content
        </Button>
      )}
      {error ? (
        <p
          role="alert"
          className="rounded border border-destructive p-3 text-sm"
        >
          {error}
        </p>
      ) : null}
      {unsubmitted ? (
        <p className="text-sm">
          Apply or capture your open form before saving the revision.
        </p>
      ) : null}
      {restoration ? (
        <div className="rounded border p-3 text-sm">
          <p>
            Revision {restoration.id} is selected for restoration. Applying it
            replaces the local draft; saving creates a new revision.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (
                !window.confirm(
                  "Replace your local draft with this saved revision?",
                )
              )
                return;
              const restored = draftFromRevision(restoration);
              onLocaleChange(restored.brief.locale);
              setDraft((current) => ({
                ...restored,
                expectedHeadVersion: current.expectedHeadVersion,
                expectedContextVersion: current.expectedContextVersion,
              }));
              setBriefDirty(false);
              setSourceDirty(false);
              setClaimDirty(false);
              setBriefKey((key) => key + 1);
              onRestoreApplied();
            }}
          >
            Load as draft
          </Button>
        </div>
      ) : null}
      {revision.version > draft.expectedHeadVersion ? (
        <div className="space-y-2 text-sm">
          <p>
            A newer saved revision is available. Your draft has not been
            replaced.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  "Keep your draft and use the latest revision as its base? Review the differences first.",
                )
              ) {
                setDraft((current) => ({
                  ...current,
                  expectedHeadVersion: revision.version,
                }));
                setError(null);
              }
            }}
          >
            Keep draft on latest base
          </Button>
        </div>
      ) : null}
      {currentContextVersion !== draft.expectedContextVersion ||
      JSON.stringify(savedLocale) !== JSON.stringify(draft.brief.locale) ? (
        <ContextRefresh
          saved={savedContextJson}
          current={currentContextSnapshot}
          disabled={pending || !contextReady}
          onUse={() =>
            setDraft((current) => ({
              ...current,
              expectedContextVersion: currentContextVersion,
            }))
          }
        />
      ) : null}
      <fieldset disabled={pending} className="space-y-5">
        <nav
          aria-label="Content editor sections"
          className="flex flex-wrap gap-2 border-b pb-2"
        >
          {(["write", "sources", "claims", "preview", "brief"] as const).map(
            (item) => (
              <Button
                key={item}
                type="button"
                variant={tab === item ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onTabChange(item)}
              >
                {item[0].toUpperCase() + item.slice(1)}
              </Button>
            ),
          )}
        </nav>
        {tab === "write" ? (
          <ContentEditorFields draft={draft} setDraft={setDraft} />
        ) : null}
        <div hidden={tab !== "sources"}>
          <ContentEditorSources
            draft={draft}
            setDraft={setDraft}
            briefKey={briefKey}
            onCapture={onCapture}
            setSourceDirty={setSourceDirty}
            sources={sources}
            unavailableSources={unavailableSources}
          />
        </div>
        <div hidden={tab !== "claims"}>
          <ContentClaimPanel
            key={briefKey}
            markdown={draft.markdown}
            metadata={draft.metadata}
            sources={sources
              .filter((source) => draft.sourceIds.includes(source.id))
              .map((source) => ({
                id: source.id,
                title: source.title,
                text: source.sourceText,
                kind: source.kind,
              }))}
            claims={draft.claims}
            onDirtyChange={setClaimDirty}
            onChange={(claims) =>
              setDraft((current) => ({ ...current, claims }))
            }
          />
        </div>
        {tab === "preview" ? (
          <ContentPreview markdown={draft.markdown} />
        ) : null}
        <div hidden={tab !== "brief"}>
          <ContentBriefForm
            key={briefKey}
            initialBrief={draft.brief}
            submitLabel="Apply brief changes"
            onDirtyChange={setBriefDirty}
            onSubmit={async (brief) => {
              setDraft((current) => ({ ...current, brief }));
              onLocaleChange(brief.locale);
            }}
          />
        </div>
      </fieldset>
    </section>
  );
}
