import { queryOptions } from "@tanstack/react-query";
import { getSiteAuthority } from "@/serverFunctions/siteAuthority";

export const siteAuthorityQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["site-authority", projectId],
    queryFn: () => getSiteAuthority({ data: { projectId } }),
    staleTime: 0,
  });
