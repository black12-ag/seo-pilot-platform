import {
  expect,
  request as playwrightRequest,
  test,
  type BrowserContext,
  type APIRequestContext,
} from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { env } from "./site-authority-fixture";
import {
  cleanupContentSessions,
  contentPage,
  expectContentRailPlacement,
  focusAndRefresh,
  reportContentFailure,
  signInContent,
} from "./content-review-fixture";

test("manual content survives conflicts, records human review, and exports saved evidence", async ({
  browser,
}) => {
  const baseURL = env("CONTENT_REVIEW_BASE_URL");
  const projectId = env("CONTENT_REVIEW_PROJECT_ID");
  const evidenceDir =
    process.env.CONTENT_REVIEW_EVIDENCE_DIR ??
    "/Users/munir/Documents/seo-research/platform/2026-11-02/content/manual-a/ui";
  await mkdir(evidenceDir, { recursive: true });
  const owner = await signInContent(browser, baseURL, "OWNER");
  let member: BrowserContext | undefined;
  let outsider: BrowserContext | undefined;
  let anonymous: APIRequestContext | undefined;
  let contextPage: Awaited<ReturnType<typeof owner.newPage>> | undefined;
  let primaryPage: Awaited<ReturnType<typeof owner.newPage>> | undefined;
  let originalContext: string | undefined;
  let taskFailed = false;
  try {
    member = await signInContent(browser, baseURL, "MEMBER");
    outsider = await signInContent(browser, baseURL, "OUTSIDER");
    anonymous = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: {
        Origin: baseURL,
        "x-api-key": env("CONTENT_REVIEW_API_KEY"),
      },
    });
    const page = await contentPage(owner);
    primaryPage = page;
    await page.goto(`/p/${encodeURIComponent(projectId)}/content`);
    await page.getByRole("button", { name: "New brief" }).click();
    const topic = `Reserved content ${Date.now()}`;
    await page.getByLabel("Topic or keyword").fill(topic);
    await page.getByRole("button", { name: "Save brief" }).click();
    await expect(page).toHaveURL(/\/content\/[^/?]+/);
    const editorURL = page.url();
    await page.getByRole("button", { name: "Review saved revision" }).click();
    await page.getByLabel("Reviewer").click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Request review" }).click();
    await expect(page.getByText(/request .*pending/)).toBeVisible();
    const latestReviewURL = new URL(page.url());
    latestReviewURL.searchParams.delete("requestId");
    const observer = await contentPage(owner);
    await observer.goto(latestReviewURL.toString());
    const attestation = observer.getByRole("checkbox", {
      name: "I assessed the remaining text and its factual coverage.",
    });
    await attestation.check();
    await page.bringToFront();
    await focusAndRefresh(observer);
    await expect(attestation).toBeChecked();
    await page.bringToFront();
    await page.getByRole("button", { name: "Cancel request" }).click();
    await expect(page.getByText(/request .*cancelled/)).toBeVisible();
    await page.goto(editorURL);
    await page
      .getByLabel("Markdown body")
      .fill("# Changed zero-claim revision");
    await page.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByText(/Revision 2 · Saved/)).toBeVisible();
    await page.getByRole("button", { name: "Review saved revision" }).click();
    await page.getByRole("button", { name: "Request another review" }).click();
    await page.getByLabel("Reviewer").click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Request review" }).click();
    await expect(page.getByText(/request .*pending/)).toBeVisible();
    const newRequestId = new URL(page.url()).searchParams.get("requestId");
    if (!newRequestId) throw new Error("New review ID missing");
    await focusAndRefresh(observer);
    await expect(
      observer.getByText(new RegExp(`request ${newRequestId}`)),
    ).toBeVisible();
    await expect(attestation).not.toBeChecked();
    await page.bringToFront();
    await page.getByRole("button", { name: "Cancel request" }).click();
    await expect(page.getByText(/request .*cancelled/)).toBeVisible();
    await page.goto(editorURL);
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await page.getByLabel("Source title").fill("Acceptance source");
    await page.getByLabel("Attribution").fill("Reserved fixture owner");
    await page
      .getByLabel("Source text")
      .fill("Evidence for the test sentence.");
    await page.getByRole("button", { name: "Capture source" }).click();
    await page.getByRole("checkbox", { name: /Acceptance source/ }).check();
    await page.getByRole("button", { name: "Write", exact: true }).click();
    await page
      .getByLabel("Markdown body")
      .fill("# Draft\n\nEvidence for the test sentence.");
    await page.getByRole("button", { name: "Claims", exact: true }).click();
    await page.getByLabel("Exact claim text").fill("Not in the draft");
    await page.getByRole("button", { name: "Add claim" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Body claims must match" }),
    ).toContainText("Body claims must match");
    await expect(page.getByLabel("Exact claim text")).toHaveValue(
      "Not in the draft",
    );
    await page
      .getByLabel("Exact claim text")
      .fill("Evidence for the test sentence.");
    await page.getByLabel("Evidence source (optional)").click();
    await page.getByRole("option", { name: "Acceptance source" }).click();
    await page
      .getByLabel("Exact source excerpt")
      .fill("Evidence for the test sentence.");
    await page.getByRole("button", { name: "Add claim" }).click();
    await page.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByText(/Revision 3 · Saved/)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Write", exact: true }).click();
    await expect(page.getByLabel("Markdown body")).toHaveValue(
      "# Draft\n\nEvidence for the test sentence.",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await expectContentRailPlacement(page, true);
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () =>
          document.activeElement instanceof HTMLElement &&
          document.activeElement.getBoundingClientRect().width > 0,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: join(evidenceDir, `editor-mobile-${Date.now()}.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectContentRailPlacement(page, false);
    await page.screenshot({
      path: join(evidenceDir, `editor-desktop-${Date.now()}.png`),
      fullPage: true,
    });
    await page
      .getByLabel("Markdown body")
      .fill(
        "# Draft\n\nEvidence for the test sentence.\n\nLocal context draft",
      );
    contextPage = await contentPage(owner);
    await contextPage.goto(`/p/${encodeURIComponent(projectId)}/context`);
    const overview = contextPage.getByLabel("Business overview");
    originalContext = await overview.inputValue();
    await overview.fill(`Reserved context refresh ${Date.now()}`);
    await contextPage.getByRole("button", { name: "Save changes" }).click();
    await expect(
      contextPage.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await focusAndRefresh(page);
    await expect(
      page.getByText("Project context changed. Compare before refreshing."),
    ).toBeVisible();
    await expect(page.getByText(/Revision 3 · Unsaved changes/)).toBeVisible();
    await expect(page.getByLabel("Markdown body")).toHaveValue(
      "# Draft\n\nEvidence for the test sentence.\n\nLocal context draft",
    );
    await page
      .getByText("Project context changed. Compare before refreshing.")
      .click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Use current context" }).click();

    const other = await contentPage(owner);
    await other.goto(editorURL);
    await expect(other.getByLabel("Markdown body")).toBeVisible();
    await other
      .getByText("Project context changed. Compare before refreshing.")
      .click();
    other.once("dialog", (dialog) => dialog.accept());
    await other.getByRole("button", { name: "Use current context" }).click();
    await page
      .getByLabel("Markdown body")
      .fill("# Draft\n\nEvidence for the test sentence.\n\nSaved edit");
    await other
      .getByLabel("Markdown body")
      .fill("# Draft\n\nEvidence for the test sentence.\n\nLocal conflict");
    await page.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByText(/Revision 4 · Saved/)).toBeVisible();
    await other.getByRole("button", { name: "Save revision" }).click();
    await expect(
      other.getByRole("alert").filter({ hasText: "Your draft is still here" }),
    ).toContainText("Your draft is still here");
    await expect(other.getByLabel("Markdown body")).toHaveValue(
      "# Draft\n\nEvidence for the test sentence.\n\nLocal conflict",
    );
    await page.getByRole("button", { name: "Revision history" }).click();
    const oldRevision = page
      .getByRole("listitem")
      .filter({ hasText: "Revision 3" });
    await oldRevision.getByRole("button", { name: "View" }).click();
    await expect(
      page.getByRole("region", { name: "Compare revisions" }),
    ).toBeVisible();
    await oldRevision.getByRole("button", { name: "Restore as new" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Load as draft" }).click();
    await expect(page.getByLabel("Markdown body")).toHaveValue(
      "# Draft\n\nEvidence for the test sentence.",
    );
    await page
      .getByLabel("Markdown body")
      .fill("# Draft\n\nEvidence for the test sentence.\n\nRestored edit");
    await page.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByText(/Revision 5 · Saved/)).toBeVisible();
    const preReviewDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download saved json" }).click();
    const preReviewPath = await (await preReviewDownload).path();
    if (!preReviewPath) throw new Error("Pre-review download was not saved");
    const preReview = z
      .object({ payload: z.object({ review: z.null() }) })
      .parse(JSON.parse(await readFile(preReviewPath, "utf8")));
    expect(preReview.payload.review).toBeNull();
    await page.getByRole("button", { name: "Review saved revision" }).click();
    await page.getByRole("button", { name: "Request another review" }).click();
    await page.getByLabel("Reviewer").click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Request review" }).click();
    await expect(page.getByText(/request .*pending/)).toBeVisible();
    const memberPage = await contentPage(member);
    await memberPage.goto(page.url());
    await expect(
      memberPage.getByRole("button", { name: "Approve" }),
    ).toBeDisabled();
    await page.getByLabel("Assessment", { exact: true }).click();
    await page.getByRole("option", { name: "supported", exact: true }).click();
    await page
      .getByRole("checkbox", {
        name: "I assessed the remaining text and its factual coverage.",
      })
      .check();
    const approvalRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        request.url().includes("_serverFn") &&
        (request.postData() ?? "").includes("approve"),
    );
    await page.getByRole("button", { name: "Approve" }).click();
    const captured = await approvalRequest;
    await expect(page.getByText(/request .*approved/)).toBeVisible();
    const denied = await anonymous.fetch(captured.url(), {
      method: "POST",
      headers: {
        "content-type":
          captured.headers()["content-type"] ?? "application/json",
        "x-tsr-serverfn": captured.headers()["x-tsr-serverfn"] ?? "true",
      },
      data: captured.postDataBuffer() ?? undefined,
    });
    expect(await denied.text()).toContain("UNAUTHENTICATED");
    const replay = {
      method: "POST" as const,
      headers: {
        "content-type":
          captured.headers()["content-type"] ?? "application/json",
        "x-tsr-serverfn": captured.headers()["x-tsr-serverfn"] ?? "true",
      },
      data: captured.postDataBuffer() ?? undefined,
    };
    const memberDenied = await member.request.fetch(captured.url(), replay);
    expect(await memberDenied.text()).toContain("FORBIDDEN");
    const outsiderReview = await outsider.request.fetch(captured.url(), replay);
    expect(await outsiderReview.text()).toContain("NOT_FOUND");
    await page.goto(editorURL);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download saved json" }).click();
    const path = await (await downloadPromise).path();
    if (!path) throw new Error("Download was not saved");
    const artifact = z
      .object({
        payload: z.object({
          revision: z.object({
            id: z.string(),
            contentId: z.string(),
            markdown: z.string(),
          }),
          sources: z.array(z.object({ sourceText: z.string() })),
          review: z.object({ state: z.string() }),
        }),
      })
      .parse(JSON.parse(await readFile(path, "utf8")));
    expect(artifact.payload.revision.markdown).toContain("Restored edit");
    expect(artifact.payload.sources[0].sourceText).toBe(
      "Evidence for the test sentence.",
    );
    expect(artifact.payload.review.state).toBe("approved");
    const downloadURL = `/api/content/${encodeURIComponent(projectId)}/${encodeURIComponent(artifact.payload.revision.contentId)}/${encodeURIComponent(artifact.payload.revision.id)}/export?format=json`;
    expect((await outsider.request.get(downloadURL)).status()).toBe(404);
    await page.goto(memberPage.url());
    await page.getByRole("button", { name: "Withdraw approval" }).click();
    await expect(page.getByText(/request .*withdrawn/)).toBeVisible();
    await page.goto(editorURL);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Archive content" }).click();
    await expect(page.getByText(/This content is archived/)).toBeVisible();
    await page.goto(`/p/${encodeURIComponent(projectId)}/content`);
    await page.getByRole("button", { name: "View archived content" }).click();
    await expect(
      page.getByRole("cell", { name: topic, exact: true }),
    ).toBeVisible();
  } catch (error) {
    taskFailed = true;
    await reportContentFailure(primaryPage, evidenceDir);
    throw error;
  } finally {
    await cleanupContentSessions({
      contextPage,
      originalContext,
      sessions: [owner, member, outsider],
      anonymous,
      taskFailed,
    });
  }
});
