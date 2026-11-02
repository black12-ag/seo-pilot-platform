import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/client/components/ui/button";
import type {
  ContentRevisionPage,
  SavedContentRevision,
} from "@/types/schemas/content";
import type { getContentRevision } from "@/serverFunctions/content";
import { getContentRevisionStatus } from "@/serverFunctions/content";
import { ContentRevisionHistory } from "./ContentRevisionHistory";
import { ContentRevisionComparison } from "./ContentRevisionComparison";

type RevisionRead = Awaited<ReturnType<typeof getContentRevision>>;
export function ContentHistoryPanel({
  history,
  projectId,
  contentId,
  historical,
  revisionId,
  head,
  onSelect,
  onRevert,
  onNext,
}: {
  history: UseQueryResult<ContentRevisionPage>;
  projectId: string;
  contentId: string;
  historical: UseQueryResult<RevisionRead>;
  revisionId?: string;
  head: SavedContentRevision;
  onSelect: (id: string) => void;
  onRevert: (id: string) => void;
  onNext: (cursor: string) => void;
}) {
  const status = useQuery({
    queryKey: ["content", projectId, contentId, "status", revisionId],
    queryFn: () =>
      getContentRevisionStatus({ data: { projectId, contentId, revisionId } }),
    enabled: Boolean(revisionId && historical.isError),
  });
  return (
    <section className="space-y-4">
      {history.isPending ? (
        <p>Loading history…</p>
      ) : history.isError ? (
        <p role="alert">Could not load revision history.</p>
      ) : (
        <>
          <ContentRevisionHistory
            revisions={history.data.items}
            selectedId={revisionId ?? ""}
            onSelect={onSelect}
            onRevert={onRevert}
          />
          {history.data.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onNext(history.data.nextCursor!)}
            >
              More revisions
            </Button>
          ) : null}
        </>
      )}
      {revisionId && historical.isPending ? <p>Loading revision…</p> : null}
      {revisionId && historical.isError ? (
        <p role="alert">
          {status.data?.state === "privacy_erased"
            ? "This revision was privacy erased and its body is unavailable."
            : "This revision is unavailable."}
        </p>
      ) : null}
      {historical.data ? (
        <>
          <div className="flex gap-2">
            {(["markdown", "json"] as const).map((format) => (
              <Button
                key={format}
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={`/api/content/${encodeURIComponent(projectId)}/${encodeURIComponent(contentId)}/${encodeURIComponent(historical.data.revision.id)}/export?format=${format}`}
                  />
                }
              >
                Download selected {format}
              </Button>
            ))}
          </div>
          <ContentRevisionComparison
            before={historical.data.revision}
            after={head}
          />
        </>
      ) : null}
    </section>
  );
}
