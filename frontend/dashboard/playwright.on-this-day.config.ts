import { defineConfig } from "@playwright/test"

// Own port, and NEVER reuse a server that is already listening: a busy port fails loudly instead of silently running against another checkout's
// dev server (whose .env.local may point at the deployed API).
const FRONTEND_PORT = 5199
// Nothing listens here. The dev server's API base is forced to it (a process env var outranks .env.local), and e2e/on-this-day/home-on-this-day.spec.ts
// answers every request to it from synthetic fixtures, so an un-intercepted call fails to connect instead of reaching any real API.
const FIXTURE_API_ORIGIN = "http://127.0.0.1:8794"

/** Focused run for e2e/on-this-day/home-on-this-day.spec.ts: the real Home in a real Chromium-based browser against a throwaway dev server of THIS
 * checkout and synthetic API fixtures only (no AWS, S3, Firebase or deployed On-this-day endpoint is ever contacted).
 * The system Edge/Chrome is used (`E2E_BROWSER_CHANNEL`, default msedge) so no browser download is needed; set it to "" to use Playwright's own Chromium. */
export default defineConfig({
  testDir: "./e2e/on-this-day",
  testMatch: "home-on-this-day.spec.ts",
  outputDir: process.env.E2E_OUTPUT_DIR ?? "./test-results/on-this-day",
  workers: 1,
  webServer: {
    command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
    url: `http://localhost:${FRONTEND_PORT}`,
    reuseExistingServer: false,
    env: { VITE_API_BASE_URL: FIXTURE_API_ORIGIN },
  },
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    channel: process.env.E2E_BROWSER_CHANNEL === undefined ? "msedge" : process.env.E2E_BROWSER_CHANNEL || undefined,
  },
  // The two viewports the On-this-day UI is verified at: a desktop window and a phone (the Home switches to its one-column phone layout below 768px).
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
})
