import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/client/components/ui/button";
import { ContentBriefForm } from "@/client/features/content/editor/ContentBriefForm";
import { ContentLibrary } from "@/client/features/content/library/ContentLibrary";
import { contentListQuery } from "@/client/features/content/contentQueries";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import { LOCATION_OPTIONS } from "@/shared/keyword-locations";
import { createContentBrief } from "@/serverFunctions/content";
import { contentStateSchema, type ContentBrief } from "@/types/schemas/content";

export const Route = createFileRoute("/_app/p/$projectId/content/")({
  validateSearch: z.object({
    cursor: z.string().min(1).max(255).optional(),
    create: z.boolean().optional(),
    archived: z.boolean().optional(),
    state: contentStateSchema.optional(),
  }),
  component: ContentLibraryRoute,
});

function ContentLibraryRoute() {
  const { projectId } = Route.useParams();
  const { cursor, create, archived, state } = Route.useSearch();
  const navigate = Route.useNavigate();
  const query = useQuery(
    contentListQuery({ projectId, cursor, archived, state, limit: 25 }),
  );
  const projects = useQuery(projectsQueryOptions());
  const project = projects.data?.find((item) => item.id === projectId);
  const [formDirty, setFormDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowedLeave = useRef(false);
  const attempt = useRef<{ key: string; mutationId: string } | null>(null);
  const client = useQueryClient();
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      formDirty &&
      !allowedLeave.current &&
      (current.pathname !== next.pathname ||
        !("create" in next.search && next.search.create)) &&
      !window.confirm("Discard the unfinished brief?"),
    enableBeforeUnload: formDirty,
  });
  async function createBrief(brief: ContentBrief) {
    const key = JSON.stringify(brief);
    if (attempt.current?.key !== key)
      attempt.current = { key, mutationId: crypto.randomUUID() };
    setError(null);
    try {
      const result = await createContentBrief({
        data: {
          projectId,
          mutationId: attempt.current.mutationId,
          expectedHeadVersion: 0,
          brief,
        },
      });
      if (!result.ok) {
        setError("The brief could not be saved because its state changed.");
        return false;
      }
      attempt.current = null;
      allowedLeave.current = true;
      void client.invalidateQueries({ queryKey: ["content-list", projectId] });
      await navigate({
        to: "/p/$projectId/content/$contentId",
        params: { projectId, contentId: result.revision.contentId },
        search: {},
      });
    } catch (cause) {
      allowedLeave.current = false;
      setError(
        cause instanceof Error ? cause.message : "Could not create the brief.",
      );
      return false;
    }
  }
  if (create) {
    if (!project)
      return (
        <main className="p-6">
          {projects.isPending ? "Loading project…" : "Could not load project."}
        </main>
      );
    const country =
      LOCATION_OPTIONS.find((item) => item.code === project.locationCode)
        ?.label ?? String(project.locationCode);
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
        <h1 className="text-2xl font-semibold">Start with a brief</h1>
        <p className="text-muted-foreground text-sm">
          Set the purpose and audience. Creating a brief does not generate or
          publish content.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <ContentBriefForm
          initialBrief={{
            target: project.domain ?? "",
            objective: "",
            audience: "",
            outputKind: "article",
            topic: "",
            locale: { language: project.languageCode, country },
          }}
          onDirtyChange={setFormDirty}
          onSubmit={createBrief}
        />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            void navigate({ search: { cursor, archived, state } });
          }}
        >
          Back to library
        </Button>
      </main>
    );
  }
  if (!query.data)
    return (
      <main className="p-6">
        {query.isPending ? "Loading content…" : "Could not load content."}
      </main>
    );
  return (
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <ContentLibrary
        page={query.data}
        archived={archived ?? false}
        state={state}
        onStateChange={(nextState) => {
          void navigate({ search: { archived, state: nextState } });
        }}
        onToggleArchived={() => {
          void navigate({ search: { archived: !archived } });
        }}
        onCreate={() => {
          void navigate({ search: { cursor, archived, state, create: true } });
        }}
        onOpen={(contentId) => {
          void navigate({
            to: "/p/$projectId/content/$contentId",
            params: { projectId, contentId },
            search: {},
          });
        }}
        onNext={(nextCursor) => {
          void navigate({ search: { cursor: nextCursor, archived, state } });
        }}
      />
    </main>
  );
}
