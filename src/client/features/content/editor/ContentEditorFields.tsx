import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import { Textarea } from "@/client/components/ui/textarea";
import {
  CONTENT_MARKDOWN_BYTES,
  type SaveContentRevisionInput,
} from "@/types/schemas/content";

type Draft = Omit<SaveContentRevisionInput, "mutationId">;
export function ContentEditorFields({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="content-title">Title</Label>
        <Input
          id="content-title"
          value={draft.metadata.title}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              metadata: { ...current.metadata, title: event.target.value },
            }))
          }
          className="text-base font-medium"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="content-body">
          Markdown body (maximum {CONTENT_MARKDOWN_BYTES / 1024} KB UTF-8)
        </Label>
        <Textarea
          id="content-body"
          className="min-h-[32rem] resize-y font-mono leading-7"
          value={draft.markdown}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              markdown: event.target.value,
            }))
          }
        />
      </div>
      <details className="rounded-md border px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">
          Metadata, questions and omissions
        </summary>
        <div className="mt-4 space-y-4">
          {(["slug", "description", "schemaSuggestion"] as const).map(
            (field) => (
              <div key={field} className="space-y-1">
                <Label htmlFor={`content-${field}`}>
                  {field === "schemaSuggestion"
                    ? "Schema suggestion"
                    : field[0].toUpperCase() + field.slice(1)}
                </Label>
                <Input
                  id={`content-${field}`}
                  value={draft.metadata[field]}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      metadata: {
                        ...current.metadata,
                        [field]: event.target.value,
                      },
                    }))
                  }
                />
              </div>
            ),
          )}
          {(["openQuestions", "omissions"] as const).map((field) => (
            <div key={field} className="space-y-1">
              <Label htmlFor={`content-${field}`}>
                {field === "openQuestions" ? "Open questions" : "Omissions"}{" "}
                (one per line)
              </Label>
              <Textarea
                id={`content-${field}`}
                value={draft[field].join("\n")}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [field]: event.target.value.split("\n"),
                  }))
                }
              />
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

export function ContextRefresh({
  saved,
  current,
  disabled,
  onUse,
}: {
  saved: string;
  current: unknown;
  disabled: boolean;
  onUse: () => void;
}) {
  return (
    <details className="space-y-2 rounded border p-3 text-sm">
      <summary className="cursor-pointer">
        Project context changed. Compare before refreshing.
      </summary>
      <p className="text-muted-foreground">
        Current context uses the draft locale when it is available. Saving
        creates a new context snapshot.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="font-medium">Saved context</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
            {saved}
          </pre>
        </div>
        <div>
          <h3 className="font-medium">Current context</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
            {current === null
              ? "Current context is loading or unavailable."
              : JSON.stringify(current, null, 2)}
          </pre>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          if (
            window.confirm(
              "Use the current project context for your next saved revision?",
            )
          )
            onUse();
        }}
      >
        Use current context
      </Button>
    </details>
  );
}
