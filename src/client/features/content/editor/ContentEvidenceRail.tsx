import { Button } from "@/client/components/ui/button";
import type { SavedContentRevision } from "@/types/schemas/content";
import type {
  contentSourcePageSchema,
  SavedContentCheckSet,
  SavedContentSource,
} from "@/types/schemas/contentEvidence";
import type { z } from "zod";

export function ContentEvidenceRail({
  hidden,
  revision,
  savedSources,
  unavailableSources,
  checks,
  eligibility,
  eligibilityPending,
  eligibilityError,
  sourcePage,
  sourcePending,
  sourceError,
  loadedSourceIds,
  onLoadSource,
  onNextSource,
}: {
  hidden: boolean;
  revision: SavedContentRevision;
  savedSources: SavedContentSource[];
  unavailableSources: string[];
  checks: SavedContentCheckSet;
  eligibility:
    | { eligible: true }
    | { eligible: false; reason: string }
    | undefined;
  eligibilityPending: boolean;
  eligibilityError: boolean;
  sourcePage: z.infer<typeof contentSourcePageSchema> | undefined;
  sourcePending: boolean;
  sourceError: string | null;
  loadedSourceIds: string[];
  onLoadSource: (sourceId: string) => Promise<void>;
  onNextSource: (cursor: string) => void;
}) {
  return (
    <aside
      aria-label="Saved revision sources and checks"
      hidden={hidden}
      className="min-w-0 rounded-lg border bg-card text-card-foreground"
    >
      <div className="space-y-1 border-b p-4">
        <h2 className="font-semibold">Sources &amp; review</h2>
        <p className="text-muted-foreground text-sm">
          Saved revision {revision.version} · {revision.sourceIds.length}{" "}
          {revision.sourceIds.length === 1 ? "source" : "sources"} ·{" "}
          {revision.claims.length}{" "}
          {revision.claims.length === 1 ? "claim" : "claims"}
        </p>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <div className="rounded-md border p-3">
          <p className="font-medium">Current review eligibility</p>
          <p className="text-muted-foreground mt-1">
            {eligibilityPending
              ? "Checking saved revision…"
              : eligibilityError || !eligibility
                ? "Eligibility is unavailable."
                : eligibility.eligible
                  ? "The saved revision is currently eligible."
                  : `Not currently eligible (${eligibility.reason.replaceAll("_", " ")}).`}
          </p>
        </div>
        {savedSources.length ? (
          <ul className="divide-y">
            {savedSources.map((source) => (
              <li key={source.id} className="space-y-1 py-3 first:pt-0">
                <p className="break-all font-medium">{source.title}</p>
                <p className="text-muted-foreground">
                  {source.kind === "audit"
                    ? "Audit observation"
                    : source.kind === "web"
                      ? "Public URL extraction"
                      : "Attributed text"}{" "}
                  · {source.extractionStatus}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            No sources attached to this saved revision.
          </p>
        )}
        {unavailableSources.map((id) => (
          <p key={id} role="alert">
            Source {id} is unavailable. Review and replace its evidence before
            approval.
          </p>
        ))}
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">
            Checks for saved revision {revision.version}
          </summary>
          <p className="text-muted-foreground mt-2">
            These checks describe the saved revision, not unsaved changes. Human
            review remains necessary.
          </p>
          <ul className="mt-2 space-y-2">
            {checks.checks.map((check) => (
              <li key={check.id}>
                {check.severity} · {check.status} · {check.explanation}
              </li>
            ))}
          </ul>
        </details>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">
            Find existing project sources
          </summary>
          {sourcePending ? <p>Loading sources…</p> : null}
          {sourceError ? <p role="alert">{sourceError}</p> : null}
          {sourcePage?.items.map((source) => (
            <div
              key={source.id}
              className="flex items-center justify-between gap-2 py-2"
            >
              <span className="min-w-0 break-all">
                {source.title} · {source.extractionStatus} ·{" "}
                {new Date(source.capturedAtMs).toLocaleDateString()}
                {source.available ? "" : " · unavailable"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !source.available || loadedSourceIds.includes(source.id)
                }
                onClick={() => void onLoadSource(source.id)}
              >
                Load source
              </Button>
            </div>
          ))}
          {sourcePage?.nextCursor ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onNextSource(sourcePage.nextCursor ?? "")}
            >
              More sources
            </Button>
          ) : null}
        </details>
      </div>
    </aside>
  );
}
