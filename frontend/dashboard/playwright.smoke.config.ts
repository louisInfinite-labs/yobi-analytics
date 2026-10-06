import { defineConfig } from "@playwright/test"
import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../..")
const venvPython = path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
const localApiServerScript = path.join(repoRoot, "scripts", "local_api_server.py")

// Separate ports from the existing playwright.config.ts (8787 / 5173) so this
// suite never collides with, or silently reuses, that suite's already-running
// dev server/API fixture when both happen to run on the same machine.
const SMOKE_API_PORT = 8790
const SMOKE_FRONTEND_PORT = 5180

// docs/testing/V1_PRODUCTION_E2E_SMOKE_TEST.md's Preconditions table: the
// real production frontend URL is TBD (no Firebase Hosting/custom domain is
// wired up yet) and the real production API URL is only a candidate pending
// independent re-verification. Passing these two env vars points this exact
// same suite at a real deployed target instead of the local fixture below --
// nothing in this config file changes to do that.
const frontendBaseURL = process.env.SMOKE_FRONTEND_URL
const apiBaseURLOverride = process.env.SMOKE_API_BASE_URL

// The two env vars must be set together, or neither. Setting only one would
// otherwise silently run a mixed-mode suite -- e.g. SMOKE_API_BASE_URL alone
// still starts the local webServer pair below (frontendBaseURL is falsy), so
// app-shell.spec.ts would navigate the local dev server/fixture while
// api-contract.spec.ts's own requests went to the real target -- with
// nothing surfacing that mismatch to whoever ran it.
if (Boolean(frontendBaseURL) !== Boolean(apiBaseURLOverride)) {
  throw new Error(
    "playwright.smoke.config.ts: set SMOKE_FRONTEND_URL and SMOKE_API_BASE_URL together, or set neither. " +
      "Setting only one leaves the other half of the suite pointed at the local fixture instead of your intended target.",
  )
}

/** The automated layer of docs/testing/V1_PRODUCTION_E2E_SMOKE_TEST.md --
 * a separate, narrower suite from the existing interaction-regression
 * playwright.config.ts (same framework, same scripts/local_api_server.py
 * fixture script, own config/testDir/ports so the two suites can never
 * interfere with each other). Local run: starts its own API fixture with
 * --enable-smoke-routes (see that script's module docstring for exactly
 * which additional routes that is, and why) and its own throwaway dev
 * server. Pointed at a real target: no local servers are started at all. */
export default defineConfig({
  testDir: "./e2e/smoke",
  webServer: frontendBaseURL
    ? undefined
    : [
        {
          command: `"${venvPython}" "${localApiServerScript}" --port ${SMOKE_API_PORT} --enable-smoke-routes`,
          url: `http://127.0.0.1:${SMOKE_API_PORT}/dashboard/chart-catalog`,
          reuseExistingServer: !process.env.CI,
        },
        {
          command: `npm run dev -- --port ${SMOKE_FRONTEND_PORT} --strictPort`,
          url: `http://localhost:${SMOKE_FRONTEND_PORT}`,
          reuseExistingServer: !process.env.CI,
          env: { VITE_API_BASE_URL: `http://127.0.0.1:${SMOKE_API_PORT}` },
        },
      ],
  use: {
    baseURL: frontendBaseURL || `http://localhost:${SMOKE_FRONTEND_PORT}`,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})

/** This config's own default local API fixture port, exported so
 * e2e/smoke/helpers.ts's smokeApiBaseURL() can fall back to it without
 * duplicating the constant. */
export const DEFAULT_SMOKE_API_BASE_URL = `http://127.0.0.1:${SMOKE_API_PORT}`
