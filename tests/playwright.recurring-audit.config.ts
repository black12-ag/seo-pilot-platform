import { defineConfig } from "@playwright/test";

// Root supplies an already-backed-up, migrated local password-mode app and fixture env.
export default defineConfig({
  testDir: ".",
  testMatch: "recurring-audit.spec.ts",
  outputDir:
    process.env.RECURRING_AUDIT_EVIDENCE_DIR ??
    "../test-results/recurring-audit",
  workers: 1,
  timeout: 1_200_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.RECURRING_AUDIT_BASE_URL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
});
