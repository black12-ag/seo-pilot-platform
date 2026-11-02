import { queryOptions } from "@tanstack/react-query";
import {
  getContentRevision,
  listContentRevisions,
  listContentSources,
  listContent,
} from "@/serverFunctions/content";
import type { ListContentInput, ContentLocale } from "@/types/schemas/content";

export const contentListQuery = (input: ListContentInput) =>
  queryOptions({
    queryKey: ["content-list", input.projectId, input],
    queryFn: () => listContent({ data: input }),
    staleTime: 0,
  });

export const contentRevisionQuery = (
  projectId: string,
  contentId: string,
  revisionId?: string,
  locale?: ContentLocale,
) =>
  queryOptions({
    queryKey: [
      "content",
      projectId,
      contentId,
      "revision",
      revisionId ?? "head",
      locale ?? null,
    ],
    queryFn: () =>
      getContentRevision({
        data: { projectId, contentId, revisionId, locale },
      }),
    staleTime: 0,
  });

export const contentHistoryQuery = (
  projectId: string,
  contentId: string,
  cursor?: string,
) =>
  queryOptions({
    queryKey: ["content", projectId, contentId, "history", cursor],
    queryFn: () =>
      listContentRevisions({ data: { projectId, contentId, cursor } }),
    staleTime: 0,
  });

export const contentSourcesQuery = (projectId: string, cursor?: string) =>
  queryOptions({
    queryKey: ["content-sources", projectId, cursor],
    queryFn: () => listContentSources({ data: { projectId, cursor } }),
    staleTime: 0,
  });
