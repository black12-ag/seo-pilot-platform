import { env } from "cloudflare:workers";
import { getContextFetch } from "@/server/lib/provider-access";
import {
  estimateRenderingCredits,
  renderUsageCredits,
  type RenderUsage,
} from "@/shared/audit-rendering";

/** One crawl chunk owns its rendering counters; durable results aggregate them. */
export function createChunkRendering(input: {
  auditId: string;
  renderJavaScript?: boolean;
  previousUsage: RenderUsage;
  renderHold?: { deadlineAt: number; credits: number };
}) {
  const { auditId } = input;
  // This attempt's rendering counts, returned in the step result. The audit's
  // credit lock is settled once, when the audit ends.
  const renderUsage: RenderUsage = { cloudflareAttempts: 0, contextCredits: 0 };
  // Whether `pending` in-flight pages and one more, each at the Context worst
  // case, still fit the hold on top of what this audit has rendered so far.
  const canAffordRender = (pending: number) =>
    !input.renderHold ||
    renderUsageCredits({
      cloudflareAttempts:
        input.previousUsage.cloudflareAttempts + renderUsage.cloudflareAttempts,
      contextCredits:
        input.previousUsage.contextCredits + renderUsage.contextCredits,
    }) +
      estimateRenderingCredits(pending + 1).high <=
      input.renderHold.credits;
  const render = input.renderJavaScript
    ? async (url: string) => {
        const { RenderedPageService } =
          await import("@/server/lib/audit/rendered-page");
        return RenderedPageService.renderPage(url, {
          browser: env.BROWSER,
          // Behind an Every App gateway its calls are the audit's
          // organization's, named around the Workflow's run() and carried
          // into this step by pgStep.
          contextFetch: await getContextFetch(),
          auditId,
          usage: renderUsage,
        });
      }
    : undefined;

  return { renderUsage, canAffordRender, render };
}
