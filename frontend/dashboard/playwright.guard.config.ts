import { defineConfig } from "@playwright/test"
import { ANALYTICS_LAUNCH_ARGS } from "./e2e/helpers/automationGuard.mjs"

/** Focused run for e2e/guard (the automation-guard regression tests): no dev server and no API fixture -- the specs start their own
 * throwaway local servers, so this never touches production or the other suites' ports. */
export default defineConfig({
  testDir: "./e2e/guard",
  use: { launchOptions: { args: ANALYTICS_LAUNCH_ARGS } },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})
