import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { z } from "zod";
import { join } from "node:path";
import { env } from "./site-authority-fixture";
import {
  cleanupContentSessions,
  contentPage,
  signInContent,
} from "./content-review-fixture";

const ids = (body: string) =>
  new Set(
    body.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ) ?? [],
  );

async function counts(request: APIRequestContext) {
  const response = await request.get("http://127.0.0.1:4415/__counts");
  expect(response.ok()).toBe(true);
  return z.record(z.string(), z.number()).parse(await response.json());
}

async function expectUrlLayout(
  page: Page,
  capturedUrl?: string,
  longInput = false,
) {
  const section = page.locator("section[aria-labelledby=public-urls-title]");
  const geometry = await section.evaluate((element, url) => {
    const fieldset = element.closest("fieldset")!;
    const parent = fieldset.parentElement!;
    const scroller = element.closest("div.min-h-0.flex-1.overflow-auto")!;
    const viewport = scroller.getBoundingClientRect();
    const selection = url
      ? [...fieldset.querySelectorAll("label")].find((label) =>
          label.textContent?.includes(url),
        )
      : undefined;
    const link = url ? element.querySelector("article a") : undefined;
    const bounds = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left - viewport.left,
        right: rect.right - viewport.left,
      };
    };
    const textarea = element.querySelector("textarea")!;
    return {
      fieldset: bounds(fieldset),
      parent: bounds(parent),
      viewport: bounds(scroller),
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
      section: bounds(element),
      link: link ? bounds(link) : null,
      selection: selection ? bounds(selection) : null,
      textareaHeight: textarea.getBoundingClientRect().height,
      textareaScrollHeight: textarea.scrollHeight,
      viewportWidth: viewport.width,
    };
  }, capturedUrl);
  expect(geometry.fieldset.left).toBeGreaterThanOrEqual(
    geometry.parent.left - 1,
  );
  expect(geometry.fieldset.right).toBeLessThanOrEqual(
    geometry.parent.right + 1,
  );
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.scrollLeft).toBe(0);
  expect(geometry.viewportWidth).toBeGreaterThan(0);
  for (const bounds of [geometry.section, geometry.link, geometry.selection]) {
    if (!bounds) continue;
    expect(bounds.left).toBeGreaterThanOrEqual(geometry.viewport.left - 1);
    expect(bounds.right).toBeLessThanOrEqual(geometry.viewport.right + 1);
  }
  if (capturedUrl) {
    expect(geometry.link).not.toBeNull();
    expect(geometry.selection).not.toBeNull();
  }
  expect(geometry.textareaHeight).toBeLessThanOrEqual(192 + 1);
  if (longInput)
    expect(geometry.textareaScrollHeight).toBeGreaterThan(
      geometry.textareaHeight,
    );
}

test("public capture replays a lost response and preserves each outcome and draft", async ({
  browser,
}) => {
  const baseURL = env("CONTENT_REVIEW_BASE_URL");
  const projectId = env("CONTENT_REVIEW_PROJECT_ID");
  const urls = ["USABLE", "PARTIAL", "EMPTY", "BLOCKED", "FAILED"].map(
    (state) => env(`CONTENT_URL_${state}`),
  );
  const owner = await signInContent(browser, baseURL, "OWNER");
  let taskFailed = false;
  try {
    const beforeMount = await counts(owner.request);
    const page = await contentPage(owner);
    await page.goto(`/p/${encodeURIComponent(projectId)}/content`);
    await page.getByRole("button", { name: "New brief" }).click();
    await page.getByLabel("Topic or keyword").fill(`URL intake ${Date.now()}`);
    await page.getByRole("button", { name: "Save brief" }).click();
    await expect(page).toHaveURL(/\/content\/[^/?]+/);
    await page.getByLabel("Markdown body").fill("# Unsaved local draft");
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    const urlInput = page.getByRole("textbox", {
      name: "Public URLs",
      exact: true,
    });
    await urlInput.fill(`https://example.com/${"a".repeat(1000)}`);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
      await expectUrlLayout(page, undefined, true);
      await urlInput.focus();
      await page.keyboard.press("Tab");
      await expectUrlLayout(page, undefined, true);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page
      .getByRole("textbox", { name: "Public URLs", exact: true })
      .fill(urls.join("\n"));
    await expect(
      page.getByText("Response complete:", { exact: false }),
    ).toHaveCount(0);
    expect(await counts(owner.request)).toEqual(beforeMount);
    let droppedResponse = "";
    let interceptions = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.method() === "POST" &&
        request.url().includes("_serverFn") &&
        (request.postData() ?? "").includes(urls[0]) &&
        interceptions++ === 0
      ) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        droppedResponse = await response.text();
        await route.abort();
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "Capture URLs", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry same capture" }),
    ).toBeVisible();
    const countsBeforeReplay = await counts(owner.request);
    const replayResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("_serverFn") &&
        (response.request().postData() ?? "").includes(urls[0]),
    );
    await page.getByRole("button", { name: "Retry same capture" }).click();
    const replayBody = await (await replayResponse).text();
    const countsAfterReplay = await counts(owner.request);
    expect(countsAfterReplay).toEqual(countsBeforeReplay);
    expect(ids(droppedResponse).size).toBeGreaterThanOrEqual(10);
    expect(ids(replayBody)).toEqual(ids(droppedResponse));
    const rows = page.locator(
      "section[aria-labelledby=public-urls-title] article",
    );
    await expect(rows).toHaveCount(5);
    await expectUrlLayout(page, urls[0]);
    await rows.first().getByRole("link").first().focus();
    await expectUrlLayout(page, urls[0]);
    for (const [index, status] of [
      "usable",
      "partial",
      "empty",
      "blocked",
      "failed",
    ].entries()) {
      await expect(rows.nth(index)).toContainText(status);
    }
    await expect(
      page.getByRole("textbox", { name: "Public URLs", exact: true }),
    ).toHaveValue(urls.join("\n"));
    await rows.first().getByText("Capture details").click();
    await expect(rows.first()).toContainText("Publisher date:");
    await expect(rows.first()).toContainText("Response complete:");
    const usable = page
      .locator("label")
      .filter({ hasText: urls[0] })
      .getByRole("checkbox");
    const partial = page
      .locator("label")
      .filter({ hasText: urls[1] })
      .getByRole("checkbox");
    await expect(usable).not.toBeChecked();
    await expect(partial).not.toBeChecked();
    for (const url of urls.slice(2))
      await expect(
        page.locator("label").filter({ hasText: url }).getByRole("checkbox"),
      ).toHaveCount(0);
    await usable.check();
    await partial.check();
    await page.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByText(/Revision 2 · Saved/)).toBeVisible();
    const rail = page.getByRole("complementary", {
      name: "Saved revision sources and checks",
    });
    await expect(rail).toContainText("2 sources");
    await rail.getByText("Checks for saved revision 2").click();
    await expect(rail).toContainText(
      "Source extraction is incomplete or unavailable.",
    );
    await page.screenshot({
      path: join(env("CONTENT_REVIEW_EVIDENCE_DIR"), "url-capture-desktop.png"),
      fullPage: true,
    });
    const freshResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("_serverFn") &&
        (response.request().postData() ?? "").includes(urls[0]),
    );
    await rows.first().getByRole("button", { name: "New capture" }).click();
    const freshBody = await (await freshResponse).text();
    expect(
      [...ids(freshBody)].some((id) => !ids(droppedResponse).has(id)),
    ).toBe(true);
    const freshCounts = await counts(owner.request);
    expect(freshCounts).toEqual({
      ...countsAfterReplay,
      usable: countsAfterReplay.usable + 1,
    });
    await expect(rail).toContainText("2 sources");
    await expect(rows).toHaveCount(5);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectUrlLayout(page, urls[0]);
    await page
      .getByRole("textbox", { name: "Public URLs", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(rows.first().getByRole("link").first()).toBeFocused();
    await expectUrlLayout(page, urls[0]);
    await page.keyboard.press("Tab");
    await expect(rows.first().getByText("Capture details")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      rows.first().getByRole("button", { name: "New capture" }),
    ).toBeFocused();
    await expectUrlLayout(page, urls[0]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: join(env("CONTENT_REVIEW_EVIDENCE_DIR"), "url-capture-mobile.png"),
      fullPage: true,
    });
    await page.reload();
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await expect(
      page.locator("label").filter({ hasText: urls[0] }).getByRole("checkbox"),
    ).toBeChecked();
    await expect(
      page.locator("label").filter({ hasText: urls[1] }).getByRole("checkbox"),
    ).toBeChecked();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Write", exact: true }).click();
    await expect(page.getByLabel("Markdown body")).toHaveValue(
      "# Unsaved local draft",
    );
  } catch (error) {
    taskFailed = true;
    throw error;
  } finally {
    await cleanupContentSessions({ sessions: [owner], taskFailed });
  }
});
