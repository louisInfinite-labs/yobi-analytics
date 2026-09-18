import { defineConfig } from "@playwright/test"

/** Browser-verification tooling prerequisite for MT-16 (AC3/AC7) and MT-17
 * (browser measurement output). This repository's existing `vitest`
 * config (`vite.config.ts`) runs in `jsdom`, which never loads real CSS
 * and provides no computed `:focus-visible` styling or true layout engine
 * -- see `dashboardResponsive.ts`/`DashboardCanonicalEditor.accessibility.test.tsx`'s
 * own docstrings for the specific gaps this closes. This config is
 * intentionally minimal: one browser (Chromium), one local dev-server
 * target, and a dedicated `./e2e` test directory kept separate from the
 * existing `src/**\/*.test.*` jsdom suite (see `vite.config.ts`'s
 * `test.exclude`) -- no existing Vitest test was moved or rewritten. */
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:5173",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})
