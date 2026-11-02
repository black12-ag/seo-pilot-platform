import { z } from "zod";
import { SiteAuthorityService } from "@/server/features/site-authority/services/SiteAuthorityService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  authorityInstructionsSchema,
  authorityMutationResultSchema,
  authorityViewSchema,
  checkAuthorityInputSchema,
  issueAuthorityInputSchema,
  readAuthorityInputSchema,
  readAuthorityResultSchema,
  revokeAuthorityInputSchema,
  type AuthorityInstructions,
  type AuthorityView,
  type CheckAuthorityInput,
  type IssueAuthorityInput,
  type ReadAuthorityInput,
  type RevokeAuthorityInput,
  type MutationResult,
} from "@/types/schemas/siteAuthority";

// Shared fields, open output objects: cached MCP clients must accept additions.
const authorityOutput = authorityViewSchema
  .extend({
    challenge: authorityViewSchema.shape.challenge.unwrap().loose().nullable(),
  })
  .loose();
const instructionsOutput = z.discriminatedUnion("method", [
  authorityInstructionsSchema.options[0].loose(),
  authorityInstructionsSchema.options[1].loose(),
]);
const resultFields = {
  authority: authorityOutput,
  instructions: instructionsOutput.optional(),
  ...optionalMetaOutputSchema,
};
const readOutput = readAuthorityResultSchema.extend(resultFields).loose();
const mutationOutput = z.discriminatedUnion("ok", [
  authorityMutationResultSchema.options[0].extend(resultFields).loose(),
  authorityMutationResultSchema.options[1]
    .extend({
      authority: authorityOutput,
      ...optionalMetaOutputSchema,
    })
    .loose(),
]);

function describeAuthority(
  authority: AuthorityView,
  instructions?: AuthorityInstructions,
) {
  const lines = [
    `Site authority: ${authority.status}; exact origin: ${authority.origin ?? "not selected"}; version ${authority.version}.`,
    authority.verifiedUntilMs
      ? `Grant expires ${new Date(authority.verifiedUntilMs).toISOString()}.`
      : "No usable grant until verification succeeds.",
    authority.challenge
      ? `Challenge ${authority.challenge.id}: ${authority.challenge.status}, ${authority.challenge.attemptsUsed}/5 checks; expires ${new Date(authority.challenge.expiresAtMs).toISOString()}.`
      : "",
    authority.challenge?.lastFailure
      ? `Last proof result: ${authority.challenge.lastFailure}.`
      : "",
    instructions?.method === "http_file"
      ? `Serve this exact content with HTTPS 200 and no redirects at ${instructions.url}:\n${instructions.content}`
      : "",
    instructions?.method === "dns_txt"
      ? `Publish a TXT record at ${instructions.name} with the exact value:\n${instructions.value}\nDNS proves the record's control, not HTTPS reachability. DNS aliases are not followed.`
      : "",
    "Proof does not connect a publisher or authorize publishing. Do not upload files or edit DNS automatically.",
  ];
  return lines.filter(Boolean).join("\n");
}

function mutationResponse(
  result: MutationResult,
  context: { baseUrl: string },
) {
  const response = mcpResponse({
    text: [
      !result.ok
        ? `Operation refused: ${result.code}.${result.retryAtMs ? ` Retry at ${new Date(result.retryAtMs).toISOString()}.` : ""}`
        : "",
      describeAuthority(
        result.authority,
        result.ok ? result.instructions : undefined,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
    structuredContent: result,
    meta: buildProjectMeta(
      context,
      result.authority.projectId,
      `/p/${result.authority.projectId}/settings/integrations#site-authority`,
    ),
  });
  return {
    ...response,
    isError:
      !result.ok ||
      (result.authority.status !== "verified" &&
        result.authority.challenge?.lastFailure != null),
  };
}

export const getSiteAuthorityTool = {
  name: "get_site_authority",
  config: {
    title: "Get site authority",
    description:
      "Read this project's exact HTTPS origin, proof status and expiry without a network lookup. Current managers also receive public challenge instructions. Members see status only. Proof does not enable publishing.",
    inputSchema: readAuthorityInputSchema,
    outputSchema: readOutput,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: ReadAuthorityInput, context) => {
    const result = await SiteAuthorityService.get(context.auth, args);
    return mcpResponse({
      text: describeAuthority(result.authority, result.instructions),
      structuredContent: result,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/settings/integrations#site-authority`,
      ),
    });
  }),
};

export const issueSiteAuthorityChallengeTool = {
  name: "issue_site_authority_challenge",
  config: {
    title: "Issue site authority challenge",
    description:
      "Issue a short-lived HTTP file or DNS TXT challenge for one exact public HTTPS origin. Requires current owner/admin permission and expectedVersion from get_site_authority. Reissuing or changing origin immediately suspends the existing grant. Return instructions for the user to publish; never edit their DNS or website automatically.",
    inputSchema: issueAuthorityInputSchema,
    outputSchema: mutationOutput,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: IssueAuthorityInput, context) =>
    mutationResponse(
      await SiteAuthorityService.issue(context.auth, args),
      context,
    ),
  ),
};

export const checkSiteAuthorityChallengeTool = {
  name: "check_site_authority_challenge",
  config: {
    title: "Check site authority challenge",
    description:
      "Explicitly check the current stored challenge using a bounded public HTTPS GET or the exact DNS TXT owner. Requires current owner/admin permission. Does not follow redirects or DNS aliases. Missing or mismatched proof stays unverified; success grants only this exact origin for 30 days, without publishing credentials. Do not poll checks automatically.",
    inputSchema: checkAuthorityInputSchema,
    outputSchema: mutationOutput,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CheckAuthorityInput, context) =>
    mutationResponse(
      await SiteAuthorityService.check(context.auth, args),
      context,
    ),
  ),
};

export const revokeSiteAuthorityTool = {
  name: "revoke_site_authority",
  config: {
    title: "Revoke site authority",
    description:
      "Revoke this project's exact site authority and invalidate any pending challenge. Requires current owner/admin permission and expectedVersion. This prevents future authorized dispatches; it cannot recall a remote write already accepted by a website.",
    inputSchema: revokeAuthorityInputSchema,
    outputSchema: mutationOutput,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: RevokeAuthorityInput, context) =>
    mutationResponse(
      await SiteAuthorityService.revoke(context.auth, args),
      context,
    ),
  ),
};
