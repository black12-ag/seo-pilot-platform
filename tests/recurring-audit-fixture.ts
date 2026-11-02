import { request as playwrightRequest, type Request } from "@playwright/test";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { z } from "zod";
import { callTool, type Credential } from "./mcp-isolation/mcp";
import { env } from "./site-authority-fixture";
import {
  auditScheduleGetResultSchema,
  auditScheduleEstimateSchema,
  auditAttemptListResultSchema,
  type auditAttemptSchema,
} from "../src/types/schemas/audit-schedule";

export async function signInRecurring(
  browser: Browser,
  baseURL: string,
  kind: "OWNER" | "MEMBER" | "OUTSIDER",
) {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  const response = await context.request.post("/api/auth/sign-in/email", {
    timeout: 15_000,
    data: {
      email: env(`RECURRING_AUDIT_${kind}_EMAIL`),
      password: env(`RECURRING_AUDIT_${kind}_PASSWORD`),
    },
  });
  expect(response.status(), "reserved fixture password sign-in").toBe(200);
  return context;
}

export async function recurringKey(context: BrowserContext) {
  const response = await context.request.post("/api/auth/api-key/create", {
    timeout: 15_000,
    data: { name: "Recurring audit acceptance" },
  });
  expect(response.status(), "temporary fixture API key").toBe(200);
  const key = z
    .object({ id: z.string(), key: z.string() })
    .parse(await response.json());
  return {
    id: key.id,
    credential: {
      label: "recurring audit acceptance",
      secret: key.key,
    } satisfies Credential,
  };
}

export async function recurringPage(
  context: BrowserContext,
  projectId: string,
) {
  const page = await context.newPage();
  const dialog = page.getByRole("dialog", { name: "One quick setup step" });
  await page.addLocatorHandler(dialog, () =>
    dialog.getByRole("button", { name: "Dismiss", exact: true }).click(),
  );
  await page.goto(`/p/${projectId}/audit`);
  return page;
}

export async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

export async function readSchedule(
  context: BrowserContext,
  credential: Credential,
  projectId: string,
) {
  const result = await callTool(context.request, credential, {
    name: "get_audit_schedule",
    arguments: { projectId },
  });
  expect(result.isError, "read schedule through MCP").toBe(false);
  return auditScheduleGetResultSchema.loose().parse(result.structuredContent);
}

export async function pauseSchedule(
  context: BrowserContext,
  credential: Credential,
  projectId: string,
) {
  const current = await readSchedule(context, credential, projectId);
  if (!current.schedule) return;
  const input = { ...current.schedule.settings, state: "paused" as const };
  const estimated = await callTool(context.request, credential, {
    name: "estimate_audit_schedule",
    arguments: input,
  });
  expect(estimated.isError, "cleanup estimate").toBe(false);
  const estimate = auditScheduleEstimateSchema
    .loose()
    .parse(estimated.structuredContent);
  const paused = await callTool(context.request, credential, {
    name: "save_audit_schedule",
    arguments: {
      ...input,
      expectedVersion: current.schedule.version,
      estimateFingerprint: estimate.estimateFingerprint,
    },
  });
  expect(paused.isError, "pause task-owned schedule before root cleanup").toBe(
    false,
  );
}

export async function reviewAndSave(page: Page, enabled: boolean) {
  const section = page.locator("#audit-schedule");
  await section
    .getByRole("button", { name: "Review schedule", exact: true })
    .click();
  const review = section.getByLabel("Schedule review", { exact: true });
  await expect(review).toBeVisible();
  await review.getByRole("checkbox").check();
  await review
    .getByRole("button", {
      name: enabled ? "Enable reviewed schedule" : "Save paused schedule",
      exact: true,
    })
    .click();
  await expect(section.locator('[data-slot="badge"]')).toHaveText(
    enabled ? "enabled" : "paused",
  );
}

export async function observeDueAudit(
  page: Page,
  owner: BrowserContext,
  credential: Credential,
  projectId: string,
) {
  await page.goto(`/p/${projectId}/audit`);
  const section = page.locator("#audit-schedule");
  const next = new Date(Date.now() + 120_000);
  await section
    .getByLabel("Local hour (0–23)", { exact: true })
    .fill(String(next.getUTCHours()));
  await section
    .getByLabel("Local minute (0–59)", { exact: true })
    .fill(String(next.getUTCMinutes()));
  await choose(page, "After review", "Enable for the next occurrence");
  await reviewAndSave(page, true);
  const scheduled = await readSchedule(owner, credential, projectId);
  const due = scheduled.schedule?.nextDueAtMs;
  if (due == null || due <= Date.now() || due > Date.now() + 180_000)
    throw new Error("Expected a real near-future occurrence");
  await expect
    .poll(() => Date.now() > due, { timeout: 190_000, intervals: [1000] })
    .toBe(true);
  // Observe the existing five-minute cron; no test clock or trigger endpoint.
  let completed: z.infer<typeof auditAttemptSchema> | undefined;
  await expect
    .poll(
      async () => {
        const result = await callTool(owner.request, credential, {
          name: "list_audit_attempts",
          arguments: { projectId, limit: 25 },
        });
        const attempts = auditAttemptListResultSchema
          .loose()
          .parse(result.structuredContent).attempts;
        const attempt = attempts.find((row) => row.dueAtMs === due);
        if (
          attempt?.auditId &&
          ["completed", "failed"].includes(attempt.launchState)
        ) {
          completed = attempt;
          return true;
        }
        return false;
      },
      { timeout: 420_000, intervals: [3000] },
    )
    .toBe(true);
  if (!completed?.auditId)
    throw new Error("Expected a terminal attempt with evidence");
  await page.reload();
  await expect(
    page
      .locator("#audit-attempts")
      .getByRole("button", { name: "View evidence" })
      .first(),
  ).toBeVisible();
  await section
    .getByRole("button", { name: "Pause future audits", exact: true })
    .click();
  await expect(section.locator('[data-slot="badge"]')).toHaveText("paused");
  await page
    .locator("#audit-attempts")
    .getByRole("button", { name: "View evidence" })
    .first()
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("auditId"))
    .toBe(completed.auditId);
  return { ...completed, auditId: completed.auditId };
}

export async function assertFunctionIsolation(
  scheduleRequest: Request | undefined,
  outsider: BrowserContext,
  baseURL: string,
) {
  if (!scheduleRequest)
    throw new Error("No real schedule server-function request observed");
  const safeHeaders = Object.fromEntries(
    Object.entries(await scheduleRequest.allHeaders()).filter(
      ([name]) =>
        name.startsWith("x-tsr") || ["accept", "content-type"].includes(name),
    ),
  );
  const foreign = await outsider.request.get(scheduleRequest.url(), {
    headers: safeHeaders,
  });
  expect(await foreign.text()).toMatch(
    /NOT_FOUND|FORBIDDEN|Unauthorized|not found/i,
  );
  const anonymous = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await anonymous.get(scheduleRequest.url(), {
      headers: safeHeaders,
    });
    expect(
      [401, 403].includes(response.status()) ||
        (await response.text()).includes("UNAUTHENTICATED"),
    ).toBe(true);
    return response.status();
  } finally {
    await anonymous.dispose();
  }
}

export async function assertMemberScheduleReadOnly(
  member: BrowserContext,
  credential: Credential,
  projectId: string,
) {
  const memberPage = await recurringPage(member, projectId);
  await expect(
    memberPage.getByText("Only the current workspace owner", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    memberPage.getByLabel("Target URL", { exact: true }),
  ).toBeDisabled();
  expect((await readSchedule(member, credential, projectId)).canManage).toBe(
    false,
  );
  const memberSchedule = (await readSchedule(member, credential, projectId))
    .schedule;
  if (!memberSchedule) throw new Error("Fixture schedule missing");
  const memberEstimate = await callTool(member.request, credential, {
    name: "estimate_audit_schedule",
    arguments: memberSchedule.settings,
  });
  const memberFingerprint = z
    .object({ estimateFingerprint: z.string() })
    .parse(memberEstimate.structuredContent).estimateFingerprint;
  expect(
    (
      await callTool(member.request, credential, {
        name: "save_audit_schedule",
        arguments: {
          ...memberSchedule.settings,
          expectedVersion: memberSchedule.version,
          estimateFingerprint: memberFingerprint,
        },
      })
    ).isError,
  ).toBe(true);
}
