import { defineConfig } from "@playwright/test";

// Root supplies the isolated, backed-up password-mode app and reserved fixtures.
export default defineConfig({
  testDir: ".",
  testMatch: "content-review.spec.ts",
  outputDir:
    process.env.CONTENT_REVIEW_OUTPUT_DIR ?? "../test-results/content-review",
  workers: 1,
  timeout: 1_200_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.CONTENT_REVIEW_BASE_URL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
});
