import { Button } from "@/client/components/ui/button";
import type { ContentRevisionPage } from "@/types/schemas/content";

export function ContentRevisionHistory({
  revisions,
  selectedId,
  onSelect,
  onRevert,
}: {
  revisions: ContentRevisionPage["items"];
  selectedId: string;
  onSelect: (revisionId: string) => void;
  onRevert: (revisionId: string) => void;
}) {
  if (!revisions.length) {
    return (
      <p className="text-muted-foreground text-sm">No saved revisions yet.</p>
    );
  }
  return (
    <section aria-label="Revision history" className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Revisions are immutable. Restoring a revision creates a new version.
      </p>
      <ul className="divide-y rounded border">
        {revisions.map((revision) => (
          <li
            key={revision.id}
            className="flex flex-wrap items-center justify-between gap-3 p-3"
          >
            <div className="text-sm">
              <p className="font-medium">
                Revision {revision.version}
                {revision.id === selectedId ? " · selected" : ""}
              </p>
              <p className="text-muted-foreground">
                {revision.id} · {revision.authorUserId ?? "Unknown author"} ·{" "}
                {revision.surface} ·{" "}
                {new Date(revision.createdAtMs).toLocaleString()}
                {revision.redactedAtMs !== null ? " · Privacy erased" : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revision.redactedAtMs !== null}
                onClick={() => onSelect(revision.id)}
              >
                View
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revision.redactedAtMs !== null}
                onClick={() => onRevert(revision.id)}
              >
                Restore as new
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
