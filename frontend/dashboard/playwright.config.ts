import { defineConfig } from "@playwright/test"
import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The repo-root virtual env's interpreter has a different relative layout
// per platform (Scripts/python.exe on Windows, bin/python everywhere else)
// -- resolved with Node's own path utilities, from this config file's own
// location, rather than a shell-specific `../../` string that only happens
// to work under a POSIX shell.
const repoRoot = path.resolve(__dirname, "../..")
const venvPython = path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
const localApiServerScript = path.join(repoRoot, "scripts", "local_api_server.py")

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
  webServer: [
    // The real backend (src/api_handler.py's own route dispatch,
    // validation and computation) over HTTP against a seeded local JSON store --
    // see scripts/local_api_server.py. The Dashboard's chart catalog and
    // comparison source talk to it exactly as they talk to the deployed API.
    {
      command: `"${venvPython}" "${localApiServerScript}" --port 8787 --seed-fixture`,
      url: "http://127.0.0.1:8787/dashboard/chart-catalog",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      env: { VITE_API_BASE_URL: "http://127.0.0.1:8787" },
    },
  ],
  use: {
    baseURL: "http://localhost:5173",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})
