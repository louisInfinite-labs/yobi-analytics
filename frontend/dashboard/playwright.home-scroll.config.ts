import { defineConfig } from "@playwright/test"
import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../..")
const venvPython = path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
const localApiServerScript = path.join(repoRoot, "scripts", "local_api_server.py")

// Own ports, and NEVER reuse a server that is already listening: the default config's 5173/8787 are routinely held by another checkout's dev
// server, which would silently run this spec against someone else's code. A busy port fails loudly here instead.
const API_PORT = 8793
const FRONTEND_PORT = 5183

/** Focused run for e2e/home-creator-scroll-reset.spec.ts: the real Home in real Chromium on a throwaway dev server of THIS checkout, against the
 * seeded local API fixture (scripts/local_api_server.py) -- nothing reaches production. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "home-creator-scroll-reset.spec.ts",
  webServer: [
    {
      command: `"${venvPython}" "${localApiServerScript}" --port ${API_PORT} --seed-fixture`,
      url: `http://127.0.0.1:${API_PORT}/dashboard/chart-catalog`,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      env: { VITE_API_BASE_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
  use: { baseURL: `http://localhost:${FRONTEND_PORT}` },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})
