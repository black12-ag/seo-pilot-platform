import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { env } from "./site-authority-fixture";
import { join } from "node:path";

export async function signInContent(
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
  try {
    const response = await context.request.post("/api/auth/sign-in/email", {
      timeout: 15_000,
      data: {
        email: env(`CONTENT_REVIEW_${kind}_EMAIL`),
        password: env(`CONTENT_REVIEW_${kind}_PASSWORD`),
      },
    });
    expect(response.status(), "reserved fixture password sign-in").toBe(200);
    return context;
  } catch (error) {
    await context.request
      .post("/api/auth/sign-out", { data: {} })
      .catch(() => {});
    await context.close();
    throw error;
  }
}

export async function contentPage(context: BrowserContext) {
  const page = await context.newPage();
  const dialog = page.getByRole("dialog", { name: "One quick setup step" });
  await page.addLocatorHandler(dialog, () =>
    dialog.getByRole("button", { name: "Dismiss", exact: true }).click(),
  );
  return page;
}

export async function focusAndRefresh(page: Page) {
  await page.bringToFront();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
}

export async function expectContentRailPlacement(page: Page, mobile: boolean) {
  const body = await page.getByLabel("Markdown body").boundingBox();
  const rail = await page
    .getByRole("complementary", { name: "Saved revision sources and checks" })
    .boundingBox();
  if (!body || !rail)
    throw new Error("Editor body or saved evidence rail is not visible");
  if (mobile) expect(rail.y).toBeGreaterThan(body.y + body.height);
  else expect(rail.x).toBeGreaterThan(body.x + body.width);
  await expect(
    page.getByText(/Saved revision 3 · 1 source · 1 claim/),
  ).toBeVisible();
}

export async function reportContentFailure(
  page: Page | undefined,
  evidenceDir: string,
) {
  if (!page) return;
  console.error(
    "Failure page state:",
    await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
  );
  await page
    .screenshot({
      path: join(evidenceDir, `failure-${Date.now()}.png`),
      fullPage: true,
    })
    .catch(() => {});
}

export async function cleanupContentSessions({
  contextPage,
  originalContext,
  sessions,
  anonymous,
  taskFailed,
}: {
  contextPage?: Page;
  originalContext?: string;
  sessions: Array<BrowserContext | undefined>;
  anonymous?: APIRequestContext;
  taskFailed: boolean;
}) {
  let restorationError: unknown;
  try {
    if (contextPage && originalContext !== undefined) {
      await contextPage.bringToFront();
      await contextPage.getByLabel("Business overview").fill(originalContext);
      const save = contextPage.getByRole("button", { name: "Save changes" });
      if (await save.isEnabled()) {
        await save.click();
        await expect(save).toBeDisabled();
      }
    }
  } catch (error) {
    restorationError = error;
  }
  const active = sessions.filter((session): session is BrowserContext =>
    Boolean(session),
  );
  const signouts = await Promise.allSettled(
    active.map(async (session) => {
      const result = await session.request.post("/api/auth/sign-out", {
        data: {},
      });
      const check = await session.request.get("/api/auth/get-session");
      return {
        status: result.status(),
        signedOut: check.ok() && (await check.json()) === null,
      };
    }),
  );
  await anonymous?.dispose();
  await Promise.all(active.map((session) => session.close()));
  const cleanupOk = signouts.every(
    (result) =>
      result.status === "fulfilled" &&
      result.value.status === 200 &&
      result.value.signedOut,
  );
  if (!cleanupOk)
    console.error(
      "Reserved session sign-out failed",
      signouts.map((result) =>
        result.status === "fulfilled"
          ? result.value
          : { status: "request_failed" },
      ),
    );
  if (restorationError) console.error("Reserved context restoration failed");
  if (!taskFailed) {
    if (restorationError) throw restorationError;
    expect(cleanupOk, "reserved sessions sign out").toBe(true);
  }
}
