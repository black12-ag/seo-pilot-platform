import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/client/components/ui/button";
import {
  CONTENT_SOURCE_LIMIT,
  type ContentSourceInput,
  type SavedContentSource,
} from "@/types/schemas/contentEvidence";
import type { SaveContentRevisionInput } from "@/types/schemas/content";
import { ContentSourcePanel } from "./ContentSourcePanel";
type Draft = Omit<SaveContentRevisionInput, "mutationId">;
export function ContentEditorSources({
  draft,
  setDraft,
  briefKey,
  onCapture,
  setSourceDirty,
  sources,
  unavailableSources,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  briefKey: number;
  onCapture: (source: ContentSourceInput) => Promise<void>;
  setSourceDirty: (dirty: boolean) => void;
  sources: SavedContentSource[];
  unavailableSources: string[];
}) {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Select up to {CONTENT_SOURCE_LIMIT} sources for this revision.
      </p>
      <ContentSourcePanel
        key={briefKey}
        projectId={draft.projectId}
        onCapture={onCapture}
        onDirtyChange={setSourceDirty}
      />
      {unavailableSources
        .filter((id) => draft.sourceIds.includes(id))
        .map((id) => (
          <div key={id} className="rounded border p-3 text-sm">
            Source {id} is unavailable. Remove its evidence passages before
            saving.{" "}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  sourceIds: current.sourceIds.filter(
                    (sourceId) => sourceId !== id,
                  ),
                }))
              }
            >
              Remove source
            </Button>
          </div>
        ))}
      {sources.map((source) => (
        <label
          key={source.id}
          className="flex gap-2 rounded border p-3 text-sm"
        >
          <input
            type="checkbox"
            checked={draft.sourceIds.includes(source.id)}
            disabled={
              !draft.sourceIds.includes(source.id) &&
              draft.sourceIds.length >= CONTENT_SOURCE_LIMIT
            }
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sourceIds: event.target.checked
                  ? [...current.sourceIds, source.id]
                  : current.sourceIds.filter((id) => id !== source.id),
              }))
            }
          />
          <span>
            {source.title} · {source.extractionStatus} · captured{" "}
            {new Date(source.capturedAtMs).toLocaleDateString()} · publisher
            date {source.publisherDate ?? "unknown"} · {source.extractionMethod}
          </span>
        </label>
      ))}
    </div>
  );
}
