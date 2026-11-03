import { HELP_PATHS, PRODUCT_REPOSITORY_URL } from "@/shared/product-help";
import updatePrompt from "./agentUpdatePrompt.md?raw";

export function getAgentSetupPrompt(origin: string) {
  return `Help me connect this agent to my SEO Pilot instance at ${origin}/mcp.

First identify this client and its supported remote HTTP MCP configuration. Preserve existing integrations. Follow the setup guide at ${origin}${HELP_PATHS.agent}. Use the instance endpoint, not a hosted plugin endpoint. For an authenticated instance, use OAuth if supported or create an API key at ${origin}/settings and configure an Authorization: Bearer header in the client's secret settings. Never ask me to paste a key into chat or commit it. A no-auth local deployment may not need a key; Cloudflare Access and Every App have their own access requirements.

Public SEO skills are in ${PRODUCT_REPOSITORY_URL}/tree/test/plugins/openseo/skills. Install only the public skills using this client's supported installation flow; preserve personal edits and avoid duplicates. If this client cannot install skills or connect to a local URL, explain the manual steps and limitations.

Reload if needed and verify using whoami and list_projects only when available. Report connection and skill discovery separately. Do not claim success before verification or run paid research during setup. Google and research providers require their own configuration.`;
}

export function getAgentUpdatePrompt(origin: string) {
  return updatePrompt
    .trim()
    .replaceAll("{{origin}}", origin)
    .replaceAll("{{repository}}", PRODUCT_REPOSITORY_URL);
}
