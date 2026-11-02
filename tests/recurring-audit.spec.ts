import { writeFile, readFile } from "node:fs/promises";
import {
  expect,
  test,
  type BrowserContext,
  type Request,
} from "@playwright/test";
import { z } from "zod";
import { callTool, type Credential } from "./mcp-isolation/mcp";
import {
  env,
  organizationsSchema,
  teamSchema,
  setRole,
  cleanupFixture,
} from "./site-authority-fixture";
import {
  signInRecurring,
  recurringKey,
  recurringPage,
  choose,
  readSchedule,
  pauseSchedule,
  reviewAndSave,
  observeDueAudit,
  assertFunctionIsolation,
  assertMemberScheduleReadOnly,
} from "./recurring-audit-fixture";
import {
  auditEvidenceResultSchema,
  auditEvidenceCompareResultSchema,
} from "../src/types/schemas/audit-evidence";

test("plain HTTP recurrence: reviewed schedule, two real due slots, evidence and tenant boundaries", async ({
  browser,
}, testInfo) => {
  const baseURL = new URL(env("RECURRING_AUDIT_BASE_URL")).origin;
  const target = env("RECURRING_AUDIT_TARGET_URL");
  const contexts: BrowserContext[] = [];
  const keys: { context: BrowserContext; id: string }[] = [];
  let owner: BrowserContext | undefined;
  let ownerCredential: Credential | undefined;
  let projectId: string | undefined;
  let organizationId: string | undefined;
  let memberId: string | undefined;
  let originalRole: string | undefined;
  let failure: unknown;
  const records: Record<string, unknown> = { auditIds: [], attemptIds: [] };
  try {
    owner = await signInRecurring(browser, baseURL, "OWNER");
    contexts.push(owner);
    const member = await signInRecurring(browser, baseURL, "MEMBER");
    contexts.push(member);
    const outsider = await signInRecurring(browser, baseURL, "OUTSIDER");
    contexts.push(outsider);
    const ownerKey = await recurringKey(owner);
    keys.push({ context: owner, id: ownerKey.id });
    ownerCredential = ownerKey.credential;
    const memberKey = await recurringKey(member);
    keys.push({ context: member, id: memberKey.id });
    const outsiderKey = await recurringKey(outsider);
    keys.push({ context: outsider, id: outsiderKey.id });
    const organizations = organizationsSchema.parse(
      await (await owner.request.get("/api/auth/organization/list")).json(),
    );
    expect(organizations).toHaveLength(1);
    organizationId = organizations[0].id;
    const team = teamSchema.parse(
      await (
        await owner.request.get(
          `/api/auth/organization/get-full-organization?organizationId=${organizationId}`,
        )
      ).json(),
    );
    const teammate = team.members.find(
      (row) => row.user.email === env("RECURRING_AUDIT_MEMBER_EMAIL"),
    );
    if (!teammate) throw new Error("Reserved teammate missing");
    memberId = teammate.id;
    originalRole = teammate.role;
    await setRole(owner, { organizationId, memberId, role: "member" });
    expect(
      (
        await member.request.post("/api/auth/organization/set-active", {
          data: { organizationId },
        })
      ).status(),
    ).toBe(200);
    const created = await callTool(owner.request, ownerCredential, {
      name: "create_project",
      arguments: {
        name: `Recurring acceptance ${crypto.randomUUID().slice(0, 8)}`,
        domain: new URL(target).hostname,
      },
    });
    expect(created.isError).toBe(false);
    projectId = z
      .object({ project: z.object({ id: z.string() }) })
      .parse(created.structuredContent).project.id;
    records.projectId = projectId;
    expect(
      (await readSchedule(owner, ownerCredential, projectId)).schedule,
    ).toBeNull();
    const page = await recurringPage(owner, projectId);
    let scheduleRequest: Request | undefined;
    page.on("response", async (response) => {
      if (
        response.request().method() === "GET" &&
        response.url().includes("_serverFn")
      ) {
        const body = await response.text().catch(() => "");
        if (
          body.includes("paidRecurrenceAvailable") &&
          body.includes("canManage")
        )
          scheduleRequest = response.request();
      }
    });
    await page.reload();
    const section = page.locator("#audit-schedule");
    await expect(
      section.getByText("Off by default", { exact: true }),
    ).toBeVisible();
    await section.getByLabel("Target URL", { exact: true }).fill(target);
    await section.getByLabel("IANA timezone", { exact: true }).fill("UTC");
    await section
      .getByLabel("Maximum pages per run", { exact: true })
      .fill("10");
    await section
      .getByLabel("Maximum pages per UTC day", { exact: true })
      .fill("20");
    await section
      .getByLabel("Maximum runs per UTC day", { exact: true })
      .fill("2");
    await choose(
      page,
      "JavaScript rendering",
      "On · unavailable for recurrence",
    );
    await expect(section.getByRole("alert")).toContainText("unavailable");
    await section
      .getByRole("button", { name: "Review schedule", exact: true })
      .click();
    await expect(
      section.getByRole("button", {
        name: "Save paused schedule",
        exact: true,
      }),
    ).toBeDisabled();
    await choose(page, "JavaScript rendering", "Off · plain HTTP");
    await reviewAndSave(page, false);
    expect(
      (await readSchedule(owner, ownerCredential, projectId)).schedule
        ?.nextDueAtMs,
    ).toBeNull();
    // Another client changes the revision after this UI has reviewed it.
    await section
      .getByRole("button", { name: "Review schedule", exact: true })
      .click();
    await section
      .getByLabel("Schedule review", { exact: true })
      .getByRole("checkbox")
      .check();
    await pauseSchedule(owner, ownerCredential, projectId);
    await section
      .getByRole("button", { name: "Save paused schedule", exact: true })
      .click();
    await expect(
      page.getByText("This request conflicts with existing data.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      section.getByLabel("Schedule review", { exact: true }),
    ).toHaveCount(0);
    await reviewAndSave(page, false);
    await assertMemberScheduleReadOnly(member, memberKey.credential, projectId);
    expect(
      (
        await callTool(outsider.request, outsiderKey.credential, {
          name: "get_audit_schedule",
          arguments: { projectId },
        })
      ).isError,
    ).toBe(true);
    records.anonymousServerFunctionStatus = await assertFunctionIsolation(
      scheduleRequest,
      outsider,
      baseURL,
    );
    const auditIds: string[] = [];
    const attemptIds: string[] = [];
    records.auditIds = auditIds;
    records.attemptIds = attemptIds;
    for (let run = 0; run < 2; run++) {
      const attempt = await observeDueAudit(
        page,
        owner,
        ownerCredential,
        projectId,
      );
      records[`attempt${run + 1}`] = attempt;
      auditIds.push(attempt.auditId);
      attemptIds.push(attempt.id);
    }
    await page.goto(`/p/${projectId}/audit?auditId=${auditIds[1]}`);
    await expect(
      page.locator("#audit-evidence").getByText(/^Coverage:/),
    ).toBeVisible();
    const evidence = auditEvidenceResultSchema.loose().parse(
      (
        await callTool(owner.request, ownerCredential, {
          name: "get_audit_evidence",
          arguments: { projectId, auditId: auditIds[1] },
        })
      ).structuredContent,
    );
    expect(evidence.state).toBe("sealed");
    records.coverage = evidence.manifest?.coverage;
    const compared = auditEvidenceCompareResultSchema.loose().parse(
      (
        await callTool(owner.request, ownerCredential, {
          name: "compare_audit_evidence",
          arguments: {
            projectId,
            auditId: auditIds[1],
            baselineAuditId: auditIds[0],
          },
        })
      ).structuredContent,
    );
    records.comparison = {
      comparable: compared.comparable,
      reason: compared.reason,
      matchedPages: compared.matchedPages,
    };
    await page.getByLabel("Baseline audit", { exact: true }).click();
    await page
      .getByRole("option")
      .filter({ hasText: auditIds[0].slice(0, 8) })
      .click();
    await expect(
      page.getByText(
        compared.comparable
          ? /Matched assessed cohort:/
          : /Not directly comparable:/,
      ),
    ).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("button", { name: "Export evidence JSON", exact: true })
        .click(),
    ]);
    const path = await download.path();
    if (!path) throw new Error("Missing evidence download");
    const exported = z
      .object({
        manifest: z.object({ auditId: z.string() }),
        pages: z.array(z.object({ id: z.string(), url: z.string() })),
        issues: z.array(z.unknown()),
        lighthouse: z.array(z.unknown()),
      })
      .parse(JSON.parse(await readFile(path, "utf8")));
    expect(exported.manifest.auditId).toBe(auditIds[1]);
    records.exportedPageRows = exported.pages.length;
    for (const name of [
      "get_audit_evidence",
      "export_audit_evidence",
      "compare_audit_evidence",
    ]) {
      const result = await callTool(outsider.request, outsiderKey.credential, {
        name,
        arguments: {
          projectId,
          auditId: auditIds[1],
          ...(name === "compare_audit_evidence"
            ? { baselineAuditId: auditIds[0] }
            : {}),
        },
      });
      expect(result.isError).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1600 });
    await page
      .locator("#audit-evidence")
      .screenshot({ path: testInfo.outputPath("evidence-desktop.png") });
    await page.goto(`/p/${projectId}/audit`);
    await page.setViewportSize({ width: 390, height: 1500 });
    await section.screenshot({
      path: testInfo.outputPath("schedule-mobile.png"),
    });
  } catch (error) {
    failure = error;
  }
  try {
    if (owner && ownerCredential && projectId)
      await pauseSchedule(owner, ownerCredential, projectId);
  } catch {
    records.pauseCleanupFailed = true;
    failure ??= new Error("Could not pause fixture schedule before cleanup");
  }
  try {
    await cleanupFixture({
      contexts,
      keys,
      owner,
      memberId,
      organizationId,
      originalRole,
    });
  } catch {
    records.authCleanupFailed = true;
    failure ??= new Error("Fixture session/key/role cleanup incomplete");
  }
  records.requiresRootScopedRecordCleanup = Boolean(projectId);
  await writeFile(
    testInfo.outputPath("recurring-entry-results.json"),
    JSON.stringify(records, null, 2),
  );
  if (failure) throw failure;
});
