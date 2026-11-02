import { adaptMcpTool, type McpToolDefinition } from "./adaptMcpTool";
import { waitingAuditStatusTool, recurringAuditTools } from "./samAuditTools";
import { contentTools } from "./samContentTools";
import {
  getAiVisibilityTrackerTool,
  generateAiVisibilityPromptsTool,
  researchAiVisibilityPromptsTool,
  completeAiResearchSetupTool,
  saveAiVisibilityTrackerTool,
  estimateAiVisibilityCostTool,
  setAiVisibilityScheduleTool,
  runAiVisibilityCheckTool,
  getAiVisibilityRunTool,
  getAiVisibilityResultsTool,
  getAiVisibilityAnswerTool,
  getAiVisibilitySourcesTool,
  getAiVisibilityTrendTool,
  exportAiVisibilityDataTool,
} from "@/server/mcp/tools/ai-visibility-tools";
import { tool, type ToolSet } from "ai";
import { z, type ZodRawShape } from "zod";
import {
  getSiteAuthorityTool,
  issueSiteAuthorityChallengeTool,
  checkSiteAuthorityChallengeTool,
  revokeSiteAuthorityTool,
} from "@/server/mcp/tools/site-authority";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type ToolAuthContext, type ToolContext } from "@/server/mcp/context";
import { getBacklinksOverviewTool } from "@/server/mcp/tools/get-backlinks-overview";
import { getBacklinksProfileTool } from "@/server/mcp/tools/get-backlinks-profile";
import { getDomainKeywordSuggestionsTool } from "@/server/mcp/tools/get-domain-keyword-suggestions";
import { getDomainOverviewTool } from "@/server/mcp/tools/get-domain-overview";
import { addRankTrackingKeywordsTool } from "@/server/mcp/tools/add-rank-tracking-keywords";
import { createRankTrackerTool } from "@/server/mcp/tools/create-rank-tracker";
import { estimateRankTrackerCostTool } from "@/server/mcp/tools/estimate-rank-tracker-cost";
import { getRankTrackerTool } from "@/server/mcp/tools/get-rank-tracker";
import { removeRankTrackingKeywordsTool } from "@/server/mcp/tools/remove-rank-tracking-keywords";
import { pinRankTrackingKeywordsTool } from "@/server/mcp/tools/pin-rank-tracking-keywords";
import { runRankTrackerTool } from "@/server/mcp/tools/run-rank-tracker";
import { searchSerpLocationsTool } from "@/server/mcp/tools/search-serp-locations";
import { getSerpResultsTool } from "@/server/mcp/tools/get-serp-results";
import {
  getAuditIssuesTool,
  getAuditPagesTool,
  runSiteAuditTool,
} from "@/server/mcp/tools/site-audit-tools";
import { listSavedKeywordsTool } from "@/server/mcp/tools/list-saved-keywords";
import { removeSavedKeywordsTool } from "@/server/mcp/tools/remove-saved-keywords";
import { buildUpdateProjectContextTool } from "@/server/mcp/tools/project-context";
import {
  getGoogleAnalyticsAudienceBreakdownTool,
  getGoogleAnalyticsEcommercePerformanceTool,
  getGoogleAnalyticsKeyEventsTool,
  getGoogleAnalyticsMeasurementHealthTool,
  getGoogleAnalyticsOrganicLandingPagesTool,
  getGoogleAnalyticsOrganicOverviewTool,
  getGoogleAnalyticsPagePerformanceTool,
  getGoogleAnalyticsSiteSearchTool,
  getGoogleAnalyticsTrafficAcquisitionTool,
  getSearchOpportunitiesTool,
} from "@/server/mcp/tools/google-analytics-tools";
import {
  findSerpCompetitorsTool,
  getGoogleBusinessQuestionsTool,
  getKeywordMetricsTool,
  getLocalSerpResultsTool,
  getRankedKeywordsTool,
  searchLocalBusinessesTool,
} from "@/server/mcp/tools/dataforseo-research-tools";
import {
  getBusinessProfileTool,
  getBusinessReviewsTool,
  getBusinessUpdatesTool,
  getLocalRankGridTool,
  listBusinessCategoriesTool,
} from "@/server/mcp/tools/local-seo-tools";
import { researchKeywordsTool } from "@/server/mcp/tools/research-keywords";
import { saveKeywordsTool } from "@/server/mcp/tools/save-keywords";
import {
  getSearchConsolePerformanceTool,
  inspectUrlsTool,
} from "@/server/mcp/tools/search-console-tools";
import { whoamiTool } from "@/server/mcp/tools/whoami";
import { explorePromptTool } from "@/server/mcp/tools/explore-prompt";
import { discoverSiteUrls, readPages, readSite } from "@/server/lib/scrape";
import { capToolOutput } from "@/server/features/sam/samToolOutput";
import openSeoFactSheet from "@/server/features/sam/openseo-fact-sheet.md?raw";

// Enough pages for SAM to work out what a business does, sells, and positions
// against on its own.
const SAM_MAX_SCRAPE_PAGES = 10;
const SAM_MAX_MAPPED_URLS = 60;

// Free (credit-less) site-reading tools, split into discovery + reading so the
// model can pick which pages to read instead of blindly taking the first N
// sitemap entries.
function scrapeTools(projectDomain: string | null): ToolSet {
  return {
    map_links: tool({
      description:
        "List a site's page URLs (homepage plus its sitemap) so you can choose which pages to read with read_pages. Defaults to the project's own site; pass `domain` to map another site (e.g. a competitor). Uses no credits.",
      inputSchema: z.object({
        domain: z
          .string()
          .optional()
          .describe("Domain or URL to map. Omit for the project's own site."),
      }),
      execute: async ({ domain }) => {
        const target = domain ?? projectDomain;
        if (!target) {
          return {
            error:
              "This project has no website set — ask the user for their site first.",
          };
        }
        const result = await discoverSiteUrls(target, SAM_MAX_MAPPED_URLS);
        return result.blocked
          ? { blocked: true, urls: [], note: "Could not reach the site." }
          : { blocked: false, urls: result.urls };
      },
    }),
    read_pages: tool({
      description: `Read up to ${SAM_MAX_SCRAPE_PAGES} web pages as plain text — the project's own pages or anyone else's (competitors, references). Pass specific \`urls\` (usually picked from map_links); omit to read a representative sample of the project's own site. Uses no credits.`,
      inputSchema: z.object({
        urls: z
          .array(z.string().url())
          .max(SAM_MAX_SCRAPE_PAGES)
          .optional()
          .describe(
            `Specific page URLs to read (max ${SAM_MAX_SCRAPE_PAGES}). Omit to read the project's own site.`,
          ),
      }),
      execute: async ({ urls }) => {
        const site =
          urls && urls.length > 0
            ? await readPages(urls, SAM_MAX_SCRAPE_PAGES)
            : projectDomain
              ? await readSite(projectDomain, SAM_MAX_SCRAPE_PAGES)
              : null;
        if (!site) {
          return {
            error:
              "This project has no website set — ask the user for their site, or pass explicit urls.",
          };
        }
        if (site.blocked) {
          return {
            blocked: true,
            pages: [],
            note: "Could not read the requested page(s). Ask the user to describe the site instead, and say you couldn't read it.",
          };
        }
        return capToolOutput({ blocked: false, pages: site.pages });
      },
    }),
  };
}

/**
 * Builds SAM's tool surface as an AI SDK ToolSet: the full MCP toolset plus the
 * free site-reading tools. Every tool the OpenSEO MCP server exposes is
 * available except the ones a project-bound chat can't use (list_projects,
 * create_project) and get_project_context (already a context block). Auth and
 * billing context are passed directly to the shared tool handlers. DataForSEO
 * spend is metered inside the shared client, so tool calls draw down the org's
 * credits automatically.
 *
 * When the MCP server gains a tool, add it here too — this list drifted for six
 * weeks once (audit + GA4 + rank-tracker management were MCP-only) before
 * anyone noticed.
 */
export function buildSamMcpTools(
  authContext: ToolAuthContext,
  project: { id: string; domain: string | null },
  turnId?: string,
): ToolSet {
  const projectId = project.id;
  const toolContext: ToolContext = { auth: authContext, turnId };
  const adaptTool = <Shape extends ZodRawShape>(
    definition: McpToolDefinition<Shape>,
  ) => adaptMcpTool(definition, toolContext, projectId);

  // The GA4 tools define inputSchema as a built ZodObject instead of a raw
  // shape; unwrap it so the same adapter (projectId stripping included) applies.
  type AnyMcpHandler = McpToolDefinition<ZodRawShape>["handler"];
  const adaptObjectTool = (definition: {
    name: string;
    config: { description: string; inputSchema: { shape: ZodRawShape } };
    handler: (args: never, context: ToolContext) => Promise<CallToolResult>;
  }) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same arg shape; the adapter rebuilds z.object from the unwrapped shape before calling it
    const handler = definition.handler as AnyMcpHandler;
    return adaptMcpTool(
      {
        name: definition.name,
        config: {
          description: definition.config.description,
          inputSchema: definition.config.inputSchema.shape,
        },
        handler,
      },
      toolContext,
      projectId,
    );
  };

  // Note: no `list_projects`. SAM is bound to the session's project, so
  // discovering other projects isn't part of its job — every project-scoped tool
  // below has `projectId` injected server-side by adaptMcpTool.
  return {
    // On-demand product reference (kept out of the system prompt: inlining it
    // made the agent narrate hosted/self-hosted framing at signed-in users).
    get_product_info: tool({
      description:
        "The OpenSEO fact sheet: what the product does, plans/pricing, credit costs, integrations, MCP setup. Call before answering questions about OpenSEO itself. Uses no credits.",
      inputSchema: z.object({}),
      execute: () => Promise.resolve({ factSheet: openSeoFactSheet }),
    }),
    ...scrapeTools(project.domain),
    whoami: adaptTool(whoamiTool),
    get_site_authority: adaptObjectTool(getSiteAuthorityTool),
    issue_site_authority_challenge: adaptObjectTool(
      issueSiteAuthorityChallengeTool,
    ),
    check_site_authority_challenge: adaptObjectTool(
      checkSiteAuthorityChallengeTool,
    ),
    revoke_site_authority: adaptObjectTool(revokeSiteAuthorityTool),
    // Writes only: the project's memory is already injected into every turn as
    // a read-only context block, so get_project_context would just re-fetch it.
    update_project_context: adaptTool(buildUpdateProjectContextTool("sam")),
    list_saved_keywords: adaptTool(listSavedKeywordsTool),
    remove_saved_keywords: adaptTool(removeSavedKeywordsTool),
    research_keywords: adaptTool(researchKeywordsTool),
    save_keywords: adaptTool(saveKeywordsTool),
    get_domain_overview: adaptTool(getDomainOverviewTool),
    get_domain_keyword_suggestions: adaptTool(getDomainKeywordSuggestionsTool),
    get_backlinks_overview: adaptTool(getBacklinksOverviewTool),
    get_backlinks_profile: adaptTool(getBacklinksProfileTool),
    get_serp_results: adaptTool(getSerpResultsTool),
    search_serp_locations: adaptTool(searchSerpLocationsTool),
    get_ai_visibility_tracker: adaptTool(getAiVisibilityTrackerTool),
    generate_ai_visibility_prompts: adaptTool(generateAiVisibilityPromptsTool),
    research_ai_visibility_prompts: adaptTool(researchAiVisibilityPromptsTool),
    complete_ai_research_setup: adaptTool(completeAiResearchSetupTool),
    explore_prompt: adaptTool(explorePromptTool),
    save_ai_visibility_tracker: adaptTool(saveAiVisibilityTrackerTool),
    estimate_ai_visibility_cost: adaptTool(estimateAiVisibilityCostTool),
    set_ai_visibility_schedule: adaptTool(setAiVisibilityScheduleTool),
    run_ai_visibility_check: adaptTool(runAiVisibilityCheckTool),
    get_ai_visibility_run: adaptTool(getAiVisibilityRunTool),
    get_ai_visibility_results: adaptTool(getAiVisibilityResultsTool),
    get_ai_visibility_answer: adaptTool(getAiVisibilityAnswerTool),
    get_ai_visibility_sources: adaptTool(getAiVisibilitySourcesTool),
    get_ai_visibility_trend: adaptTool(getAiVisibilityTrendTool),
    export_ai_visibility_data: adaptTool(exportAiVisibilityDataTool),
    create_rank_tracker: adaptTool(createRankTrackerTool),
    get_rank_tracker: adaptTool(getRankTrackerTool),
    add_rank_tracking_keywords: adaptTool(addRankTrackingKeywordsTool),
    remove_rank_tracking_keywords: adaptTool(removeRankTrackingKeywordsTool),
    pin_rank_tracking_keywords: adaptTool(pinRankTrackingKeywordsTool),
    estimate_rank_tracker_cost: adaptTool(estimateRankTrackerCostTool),
    run_rank_tracker: adaptTool(runRankTrackerTool),
    get_ranked_keywords: adaptTool(getRankedKeywordsTool),
    find_serp_competitors: adaptTool(findSerpCompetitorsTool),
    search_local_businesses: adaptTool(searchLocalBusinessesTool),
    get_local_serp_results: adaptTool(getLocalSerpResultsTool),
    get_google_business_questions: adaptTool(getGoogleBusinessQuestionsTool),
    get_business_profile: adaptTool(getBusinessProfileTool),
    get_business_reviews: adaptTool(getBusinessReviewsTool),
    get_business_updates: adaptTool(getBusinessUpdatesTool),
    list_business_categories: adaptTool(listBusinessCategoriesTool),
    get_local_rank_grid: adaptTool(getLocalRankGridTool),
    get_keyword_metrics: adaptTool(getKeywordMetricsTool),
    get_search_console_performance: adaptTool(getSearchConsolePerformanceTool),
    inspect_urls: adaptTool(inspectUrlsTool),
    // Unconditional like the MCP server's registrations — the GA4 launch gate
    // was removed in #505.
    get_google_analytics_organic_landing_pages: adaptObjectTool(
      getGoogleAnalyticsOrganicLandingPagesTool,
    ),
    get_google_analytics_page_performance: adaptObjectTool(
      getGoogleAnalyticsPagePerformanceTool,
    ),
    get_google_analytics_key_events: adaptObjectTool(
      getGoogleAnalyticsKeyEventsTool,
    ),
    get_search_opportunities: adaptObjectTool(getSearchOpportunitiesTool),
    get_google_analytics_organic_overview: adaptObjectTool(
      getGoogleAnalyticsOrganicOverviewTool,
    ),
    get_google_analytics_traffic_acquisition: adaptObjectTool(
      getGoogleAnalyticsTrafficAcquisitionTool,
    ),
    get_google_analytics_measurement_health: adaptObjectTool(
      getGoogleAnalyticsMeasurementHealthTool,
    ),
    get_google_analytics_ecommerce_performance: adaptObjectTool(
      getGoogleAnalyticsEcommercePerformanceTool,
    ),
    get_google_analytics_site_search: adaptObjectTool(
      getGoogleAnalyticsSiteSearchTool,
    ),
    get_google_analytics_audience_breakdown: adaptObjectTool(
      getGoogleAnalyticsAudienceBreakdownTool,
    ),
    ...recurringAuditTools(toolContext, projectId),
    ...contentTools(toolContext, projectId),
    run_site_audit: adaptTool(runSiteAuditTool),
    get_audit_status: waitingAuditStatusTool(adaptTool),
    get_audit_issues: adaptTool(getAuditIssuesTool),
    get_audit_pages: adaptTool(getAuditPagesTool),
  };
}
