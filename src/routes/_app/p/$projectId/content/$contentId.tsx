import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/client/components/ui/button";
import {
  ContentEditor,
  type ContentEditorTab,
} from "@/client/features/content/editor/ContentEditor";
import {
  contentRevisionQuery,
  contentSourcesQuery,
  contentHistoryQuery,
} from "@/client/features/content/contentQueries";
import { useContentSourceCapture } from "@/client/features/content/editor/useContentSourceCapture";
import { ContentEvidenceRail } from "@/client/features/content/editor/ContentEvidenceRail";
import { ContentHistoryPanel } from "@/client/features/content/history/ContentHistoryPanel";
import {
  archiveContent,
  getContentSource,
  getContentRevisionStatus,
  saveContentRevision,
} from "@/serverFunctions/content";
import { getContentEligibility } from "@/serverFunctions/content-review";
import type { ContentLocale } from "@/types/schemas/content";

export const Route = createFileRoute("/_app/p/$projectId/content/$contentId")({
  validateSearch: z.object({
    tab: z
      .enum(["write", "sources", "claims", "preview", "brief", "history"])
      .optional(),
    revisionId: z.string().min(1).max(255).optional(),
  }),
  component: ContentRoute,
});

function ContentRoute() {
  const { projectId, contentId } = Route.useParams();
  const { tab, revisionId } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ContentPage
      key={`${projectId}/${contentId}`}
      projectId={projectId}
      contentId={contentId}
      tab={tab ?? "write"}
      revisionId={revisionId}
      onTabChange={(nextTab) => {
        void navigate({ search: (current) => ({ ...current, tab: nextTab }) });
      }}
      onSelectRevision={(nextId, restore) => {
        void navigate({
          search: (current) => ({
            ...current,
            tab: restore ? "write" : "history",
            revisionId: nextId,
          }),
        });
      }}
    />
  );
}

function ContentPage({
  projectId,
  contentId,
  tab,
  revisionId,
  onTabChange,
  onSelectRevision,
}: {
  projectId: string;
  contentId: string;
  tab: ContentEditorTab | "history";
  revisionId?: string;
  onTabChange: (tab: ContentEditorTab | "history") => void;
  onSelectRevision: (revisionId: string, restore: boolean) => void;
}) {
  const client = useQueryClient();
  const query = useQuery(contentRevisionQuery(projectId, contentId));
  const eligibility = useQuery({
    queryKey: [
      "content",
      projectId,
      contentId,
      "eligibility",
      query.data?.revision.id,
      query.data?.item.headVersion,
    ],
    queryFn: () => {
      if (!query.data) throw new Error("Saved revision is unavailable");
      return getContentEligibility({
        data: {
          projectId,
          contentId,
          revisionId: query.data.revision.id,
          expectedHeadVersion: query.data.item.headVersion,
        },
      });
    },
    enabled: Boolean(query.data),
    staleTime: 0,
  });
  const status = useQuery({
    queryKey: ["content", projectId, contentId, "status", "head"],
    queryFn: () => getContentRevisionStatus({ data: { projectId, contentId } }),
    enabled: query.isError && !query.data,
  });
  const [draftLocale, setDraftLocale] = useState<ContentLocale | undefined>();
  const localized = useQuery({
    ...contentRevisionQuery(projectId, contentId, undefined, draftLocale),
    enabled: Boolean(draftLocale),
  });
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const history = useQuery(
    contentHistoryQuery(projectId, contentId, historyCursor),
  );
  const historical = useQuery({
    ...contentRevisionQuery(projectId, contentId, revisionId),
    enabled: Boolean(revisionId),
  });
  const [restoring, setRestoring] = useState(false);
  const {
    captured,
    setCaptured,
    sourceError,
    setSourceError,
    capture,
    captureUrls,
  } = useContentSourceCapture(projectId);
  const [unavailableRestored, setUnavailableRestored] = useState<string[]>([]);
  const [sourceCursor, setSourceCursor] = useState<string | undefined>();
  const sourcePage = useQuery(contentSourcesQuery(projectId, sourceCursor));
  const archiveAttempt = useRef<{ version: number; mutationId: string } | null>(
    null,
  );
  if (!query.data) {
    return (
      <main className="p-6">
        {query.isPending || status.isLoading
          ? "Loading content…"
          : status.data?.state === "privacy_erased"
            ? "This revision was privacy erased and its body is unavailable."
            : "Could not load content."}
      </main>
    );
  }
  const data = query.data;
  const savedSources = data.sources.flatMap((entry) =>
    entry.state === "available" ? [entry.source] : [],
  );
  const sources = [
    ...savedSources,
    ...captured.filter(
      (source) => !savedSources.some((saved) => saved.id === source.id),
    ),
  ];
  const restoration = restoring ? (historical.data?.revision ?? null) : null;
  const oldSources = restoration
    ? (historical.data?.sources.flatMap((entry) =>
        entry.state === "available" ? [entry.source] : [],
      ) ?? [])
    : [];
  const editorSources = [
    ...sources,
    ...oldSources.filter(
      (source) => !sources.some((item) => item.id === source.id),
    ),
  ];
  return (
    <main className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Content
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Content editor
          </h1>
          <p className="text-muted-foreground text-sm">
            Write, check your sources and review the saved revision.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2">
            {(["markdown", "json"] as const).map((format) => (
              <Button
                key={format}
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={`/api/content/${encodeURIComponent(projectId)}/${encodeURIComponent(contentId)}/${encodeURIComponent(data.revision.id)}/export?format=${format}`}
                  />
                }
              >
                Download saved {format}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <Link
                to="/p/$projectId/content/review"
                params={{ projectId }}
                search={{ contentId }}
              />
            }
          >
            Review saved revision
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onTabChange(tab === "history" ? "write" : "history")}
          >
            {tab === "history" ? "Back to editor" : "Revision history"}
          </Button>
        </div>
      </header>
      {restoring && historical.isPending ? (
        <p>Loading the selected revision…</p>
      ) : null}
      {restoring && historical.isError ? (
        <p role="alert">
          The selected revision is unavailable or has been privacy erased.
        </p>
      ) : null}
      {tab === "history" ? (
        <ContentHistoryPanel
          projectId={projectId}
          contentId={contentId}
          history={history}
          historical={historical}
          revisionId={revisionId}
          head={data.revision}
          onSelect={(id) => {
            setRestoring(false);
            onSelectRevision(id, false);
          }}
          onRevert={(id) => {
            setRestoring(true);
            onSelectRevision(id, true);
          }}
          onNext={setHistoryCursor}
        />
      ) : null}
      {query.isRefetchError ? (
        <p role="alert">
          Could not refresh saved content. Your local draft is still available.
        </p>
      ) : null}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div
          hidden={tab === "history"}
          className="min-w-0 rounded-lg border bg-card p-4 text-card-foreground sm:p-6"
        >
          <ContentEditor
            revision={data.revision}
            sources={editorSources}
            unavailableSources={[
              ...new Set([
                ...unavailableRestored,
                ...data.sources
                  .filter((entry) => entry.state === "unavailable")
                  .map((entry) => entry.sourceId),
              ]),
            ]}
            currentContextVersion={
              localized.data?.currentContextVersion ??
              data.currentContextVersion
            }
            currentContextSnapshot={
              draftLocale
                ? localized.isError
                  ? null
                  : (localized.data?.currentContextSnapshot ?? null)
                : data.currentContextSnapshot
            }
            contextReady={
              !draftLocale || Boolean(localized.data && !localized.isError)
            }
            onLocaleChange={setDraftLocale}
            archived={data.item.archivedAtMs !== null}
            onArchive={async (version) => {
              if (archiveAttempt.current?.version !== version)
                archiveAttempt.current = {
                  version,
                  mutationId: crypto.randomUUID(),
                };
              await archiveContent({
                data: {
                  projectId,
                  contentId,
                  expectedHeadVersion: version,
                  mutationId: archiveAttempt.current.mutationId,
                },
              });
              archiveAttempt.current = null;
              void client.invalidateQueries({
                queryKey: ["content", projectId, contentId],
              });
              void client.invalidateQueries({
                queryKey: ["content-list", projectId],
              });
            }}
            tab={tab === "history" ? "write" : tab}
            onTabChange={onTabChange}
            restoration={restoration}
            onRestoreApplied={() => {
              setCaptured((current) => [
                ...current,
                ...oldSources.filter(
                  (source) => !current.some((item) => item.id === source.id),
                ),
              ]);
              setUnavailableRestored(
                historical.data?.sources
                  .filter((entry) => entry.state === "unavailable")
                  .map((entry) => entry.sourceId) ?? [],
              );
              setRestoring(false);
            }}
            onCapture={capture}
            onCaptureUrls={captureUrls}
            onSave={async (input) => {
              const result = await saveContentRevision({ data: input });
              await client.invalidateQueries({
                queryKey: ["content", projectId, contentId],
              });
              return result;
            }}
          />
        </div>
        <ContentEvidenceRail
          hidden={tab === "history"}
          revision={data.revision}
          savedSources={savedSources}
          unavailableSources={data.sources
            .filter((entry) => entry.state === "unavailable")
            .map((entry) => entry.sourceId)}
          checks={data.checks}
          eligibility={eligibility.data}
          eligibilityPending={eligibility.isPending}
          eligibilityError={eligibility.isError}
          sourcePage={sourcePage.data}
          sourcePending={sourcePage.isPending}
          sourceError={
            sourcePage.isError ? "Could not load sources." : sourceError
          }
          loadedSourceIds={sources.map((source) => source.id)}
          onLoadSource={async (sourceId) => {
            try {
              const result = await getContentSource({
                data: { projectId, sourceId },
              });
              setCaptured((current) => [...current, result]);
              setSourceError(null);
            } catch {
              setSourceError("Could not load that source.");
            }
          }}
          onNextSource={setSourceCursor}
        />
      </div>
    </main>
  );
}
