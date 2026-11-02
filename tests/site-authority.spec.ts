import {
  expect,
  test,
  request as playwrightRequest,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";
import { callTool, type Credential } from "./mcp-isolation/mcp";
import {
  env,
  statusSchema,
  organizationsSchema,
  teamSchema,
  signIn,
  apiKey,
  setRole,
  cleanupFixture,
} from "./site-authority-fixture";

async function handleSetupDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: "One quick setup step" });
  await page.addLocatorHandler(dialog, () =>
    dialog.getByRole("button", { name: "Dismiss", exact: true }).click(),
  );
}

async function projectPage(context: BrowserContext) {
  const page = await context.newPage();
  await handleSetupDialog(page);
  await page.goto("/");
  await page.waitForURL(/\/p\/[^/]+\/?(?:\?.*)?$/);
  const projectId = new URL(page.url()).pathname.split("/")[2];
  if (!projectId) throw new Error("Fixture account has no project");
  return { page, projectId };
}

async function submitIssue(page: Page, replacement: boolean) {
  const section = page.locator("#site-authority");
  await section
    .getByRole("button", {
      name: replacement ? "Reissue challenge" : "Issue challenge",
      exact: true,
    })
    .click();
  if (replacement)
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reissue challenge", exact: true })
      .click();
}

test("password UI and real server/MCP entry points preserve exact authority and current roles", async ({
  browser,
}, testInfo) => {
  const baseURL = new URL(env("SITE_AUTHORITY_BASE_URL")).origin;
  const origin = env("SITE_AUTHORITY_PROOF_ORIGIN");
  const contexts: BrowserContext[] = [];
  const keys: { context: BrowserContext; id: string }[] = [];
  let owner: BrowserContext | undefined;
  let memberId: string | undefined;
  let organizationId: string | undefined;
  let originalRole: string | undefined;
  let originalFailure = false;
  let failure: unknown;
  let authorityCleanup:
    | { credential: Credential; projectId: string; challengeId: string }
    | undefined;
  try {
    owner = await signIn(browser, baseURL, "OWNER");
    contexts.push(owner);
    const member = await signIn(browser, baseURL, "MEMBER");
    contexts.push(member);
    const outsider = await signIn(browser, baseURL, "OUTSIDER");
    contexts.push(outsider);
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
      (entry) => entry.user.email === env("SITE_AUTHORITY_MEMBER_EMAIL"),
    );
    if (!teammate)
      throw new Error("Reserved member fixture is not in the owner workspace");
    memberId = teammate.id;
    originalRole = teammate.role;
    expect(
      (
        await member.request.post("/api/auth/organization/set-active", {
          data: { organizationId },
        })
      ).status(),
    ).toBe(200);
    const { page, projectId } = await projectPage(owner);
    const other = await projectPage(outsider);
    expect(other.projectId).not.toBe(projectId);
    const ownerKey = await apiKey(owner);
    keys.push({ context: owner, id: ownerKey.id });
    const memberKey = await apiKey(member);
    keys.push({ context: member, id: memberKey.id });
    const outsiderKey = await apiKey(outsider);
    keys.push({ context: outsider, id: outsiderKey.id });
    let statusRequest: Request | undefined;
    page.on("response", async (response) => {
      if (
        response.request().method() !== "GET" ||
        !response.url().includes("_serverFn")
      )
        return;
      const body = await response.text().catch(() => "");
      if (body.includes("supportedMethods") && body.includes(projectId))
        statusRequest = response.request();
    });
    await page.goto(`/p/${projectId}/settings/integrations#site-authority`);
    const section = page.locator("#site-authority");
    await expect(
      section.getByRole("heading", { name: "Site authority", exact: true }),
    ).toBeVisible();
    await expect(section.getByLabel("Exact HTTPS origin")).toBeVisible();
    const existing = statusSchema.parse(
      (
        await callTool(owner.request, ownerKey.credential, {
          name: "get_site_authority",
          arguments: { projectId },
        })
      ).structuredContent,
    );
    expect(existing.authority.supportedMethods).toEqual([
      "http_file",
      "dns_txt",
    ]);
    expect(
      existing.authority.status,
      "fixture must not replace a live verified grant",
    ).not.toBe("verified");
    await section
      .getByLabel("Exact HTTPS origin")
      .fill(`${origin}/invalid-path`);
    await submitIssue(page, existing.authority.origin !== null);
    await expect(
      page.getByText("Please check your input and try again.", { exact: true }),
    ).toBeVisible();
    if (existing.authority.origin !== null)
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
    await section.getByLabel("Exact HTTPS origin").fill(origin);
    await submitIssue(page, existing.authority.origin !== null);
    await expect(
      section.getByRole("button", { name: "Copy file content", exact: true }),
    ).toBeVisible();
    const issued = statusSchema.parse(
      (
        await callTool(owner.request, ownerKey.credential, {
          name: "get_site_authority",
          arguments: { projectId },
        })
      ).structuredContent,
    );
    if (
      !issued.authority.challenge ||
      issued.instructions?.method !== "http_file"
    )
      throw new Error("UI did not issue HTTP instructions");
    authorityCleanup = {
      credential: ownerKey.credential,
      projectId,
      challengeId: issued.authority.challenge.id,
    };
    expect(issued.authority.origin).toBe(new URL(origin).origin);
    await section
      .getByRole("button", { name: "Copy file content", exact: true })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      issued.instructions.content,
    );
    await section
      .getByRole("button", { name: "Check verification", exact: true })
      .click();
    await expect(
      section.getByText(
        /verification file was not found|could not be reached safely|did not match|timed out|did not return a valid|address redirected|target was blocked|verification size limit/i,
      ),
    ).toBeVisible();
    const checked = statusSchema.parse(
      (
        await callTool(owner.request, ownerKey.credential, {
          name: "get_site_authority",
          arguments: { projectId },
        })
      ).structuredContent,
    );
    expect(checked.authority.status).toBe("pending");
    expect(checked.authority.challenge?.lastFailure).not.toBeNull();
    expect(checked.authority.verifiedAtMs).toBeNull();
    await page.setViewportSize({ width: 1440, height: 2000 });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({
      path: testInfo.outputPath("authority-manager.png"),
    });

    await setRole(owner, { memberId, role: "member", organizationId });
    const memberPage = await member.newPage();
    await handleSetupDialog(memberPage);
    await memberPage.goto(
      `/p/${projectId}/settings/integrations#site-authority`,
    );
    const memberSection = memberPage.locator("#site-authority");
    await expect(
      memberSection.getByText("Only current organization owners and admins", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      memberSection.getByRole("button", { name: "Copy file content" }),
    ).toHaveCount(0);
    await expect(memberSection.getByLabel("Exact HTTPS origin")).toHaveCount(0);
    const read = await callTool(member.request, memberKey.credential, {
      name: "get_site_authority",
      arguments: { projectId },
    });
    expect(statusSchema.parse(read.structuredContent).authority.canManage).toBe(
      false,
    );
    expect(read.structuredContent).not.toHaveProperty("instructions");
    const memberRefusals = [];
    for (const name of [
      "issue_site_authority_challenge",
      "check_site_authority_challenge",
      "revoke_site_authority",
    ]) {
      const args =
        name === "issue_site_authority_challenge"
          ? {
              origin,
              method: "http_file",
              expectedVersion: checked.authority.version,
            }
          : name === "check_site_authority_challenge"
            ? {
                challengeId: issued.authority.challenge.id,
                expectedVersion: checked.authority.version,
              }
            : { expectedVersion: checked.authority.version };
      const result = await callTool(member.request, memberKey.credential, {
        name,
        arguments: { projectId, ...args },
      });
      expect(result.isError).toBe(true);
      memberRefusals.push({
        name,
        httpStatus: result.status,
        isError: result.isError,
      });
    }
    const foreign = await callTool(outsider.request, outsiderKey.credential, {
      name: "get_site_authority",
      arguments: { projectId },
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.structuredContent).toBeUndefined();
    await other.page.goto(`/p/${projectId}/settings/integrations`);
    await other.page.waitForURL((url) =>
      url.pathname.includes(`/p/${other.projectId}`),
    );
    const anonymous = await playwrightRequest.newContext({ baseURL });
    const anonymousMcp = await anonymous.post("/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_site_authority", arguments: { projectId } },
      },
    });
    expect([401, 403]).toContain(anonymousMcp.status());
    if (!statusRequest)
      throw new Error("Real status server-function request was not observed");
    const safeHeaders = Object.fromEntries(
      Object.entries(await statusRequest.allHeaders()).filter(
        ([name]) =>
          name.startsWith("x-tsr") || ["accept", "content-type"].includes(name),
      ),
    );
    const anonymousStatus = await anonymous.get(statusRequest.url(), {
      headers: safeHeaders,
    });
    expect(
      [401, 403].includes(anonymousStatus.status()) ||
        (await anonymousStatus.text()).includes("UNAUTHENTICATED"),
    ).toBe(true);
    const foreignStatus = await outsider.request.get(statusRequest.url(), {
      headers: safeHeaders,
    });
    expect(await foreignStatus.text()).toMatch(
      /NOT_FOUND|FORBIDDEN|Unauthorized|not found/i,
    );
    await anonymous.dispose();
    await section
      .getByRole("button", { name: "Revoke authority", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke authority", exact: true })
      .click();
    await expect(section.getByText("revoked", { exact: true })).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Copy file content" }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 1500 });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({
      path: testInfo.outputPath("authority-mobile.png"),
    });
    const resultsPath = testInfo.outputPath("authority-entry-results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(
        {
          proofFailure: checked.authority.challenge?.lastFailure,
          proofStatus: checked.authority.status,
          memberRefusals,
          foreignMcp: { httpStatus: foreign.status, isError: foreign.isError },
          anonymousMcpHttpStatus: anonymousMcp.status(),
          anonymousServerFunctionHttpStatus: anonymousStatus.status(),
          foreignServerFunctionHttpStatus: foreignStatus.status(),
          revokedUiVisible: await section
            .getByText("revoked", { exact: true })
            .isVisible(),
        },
        null,
        2,
      ),
    );
    await testInfo.attach("authority-entry-results", {
      contentType: "application/json",
      path: resultsPath,
    });
  } catch (error) {
    originalFailure = true;
    failure = error;
  }
  try {
    await cleanupFixture({
      contexts,
      keys,
      owner,
      memberId,
      organizationId,
      originalRole,
      authority: authorityCleanup,
    });
  } catch (error) {
    if (!originalFailure) throw error;
    console.error("Fixture cleanup also failed; verify reserved test state.");
  }
  if (originalFailure) throw failure;
});
import { writeFile } from "node:fs/promises";
