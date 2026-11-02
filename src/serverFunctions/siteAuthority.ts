import { createServerFn } from "@tanstack/react-start";
import { SiteAuthorityService } from "@/server/features/site-authority/services/SiteAuthorityService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { AppError } from "@/server/lib/errors";
import {
  checkAuthorityInputSchema,
  issueAuthorityInputSchema,
  readAuthorityInputSchema,
  revokeAuthorityInputSchema,
} from "@/types/schemas/siteAuthority";

function requireBoundProject(projectId: string, boundProjectId: string) {
  if (projectId !== boundProjectId) throw new AppError("NOT_FOUND");
}

export const getSiteAuthority = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(readAuthorityInputSchema)
  .handler(async ({ context, data }) => {
    requireBoundProject(data.projectId, context.projectId);
    return SiteAuthorityService.get(context, data);
  });

export const issueSiteAuthorityChallenge = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(issueAuthorityInputSchema)
  .handler(async ({ context, data }) => {
    requireBoundProject(data.projectId, context.projectId);
    return SiteAuthorityService.issue(context, data);
  });

export const checkSiteAuthorityChallenge = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(checkAuthorityInputSchema)
  .handler(async ({ context, data }) => {
    requireBoundProject(data.projectId, context.projectId);
    return SiteAuthorityService.check(context, data);
  });

export const revokeSiteAuthority = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(revokeAuthorityInputSchema)
  .handler(async ({ context, data }) => {
    requireBoundProject(data.projectId, context.projectId);
    return SiteAuthorityService.revoke(context, data);
  });
