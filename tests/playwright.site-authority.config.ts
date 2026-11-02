import { defineConfig } from "@playwright/test";

// Runs only against an explicitly supplied, already-running password-mode app.
export default defineConfig({
  testDir: ".",
  testMatch: "site-authority.spec.ts",
  outputDir:
    process.env.SITE_AUTHORITY_EVIDENCE_DIR ?? "../test-results/site-authority",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.SITE_AUTHORITY_BASE_URL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
});
