import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
// @ts-expect-error -- a plain ESM script with no type declarations
import { loadAllowlist, scanDirectory } from "./check-bundle-secrets.mjs"

const SCRIPT = resolve(__dirname, "check-bundle-secrets.mjs")
// Built at runtime so this test file itself never contains a key-shaped literal.
const FAKE_GOOGLE_KEY = "AI" + "za" + "A".repeat(35)
const FAKE_AWS_KEY = "AK" + "IA" + "B".repeat(16)

let dist: string

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "bundle-gate-"))
  mkdirSync(join(dist, "assets"))
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>")
  writeFileSync(join(dist, "assets", "app.js"), 'const apiBase="https://api.example.invalid";export{apiBase}')
})

afterEach(() => rmSync(dist, { recursive: true, force: true }))

function run(directory: string, allowlist?: string) {
  const args = [SCRIPT, directory, ...(allowlist ? [allowlist] : [])]
  return spawnSync(process.execPath, args, { encoding: "utf8" })
}

describe("scanDirectory", () => {
  it("passes a clean build", () => {
    expect(scanDirectory(dist)).toEqual([])
  })

  it.each([
    ["a Google API key", FAKE_GOOGLE_KEY, "google-api-key"],
    ["an AWS access key id", FAKE_AWS_KEY, "aws-access-key-id"],
    ["a private key block", "-----BEGIN " + "PRIVATE KEY-----", "private-key-block"],
    ["a reference to a secret-bearing build variable", "VITE_" + "HOLODEX_API_KEY", "secret-bearing-build-variable"],
    ["the App Check debug-token build variable", "VITE_" + "APPCHECK_DEBUG_TOKEN", "appcheck-debug-token"],
  ])("fails a build containing %s, without printing the full value", (_label, value, rule) => {
    writeFileSync(join(dist, "assets", "leak.js"), `var x="${value}";`)

    const findings = scanDirectory(dist)

    expect(findings.map((f: { rule: string }) => f.rule)).toContain(rule)
    expect(JSON.stringify(findings)).not.toContain(value)
  })

  it("scans nested files and source maps too", () => {
    writeFileSync(join(dist, "assets", "app.js.map"), `{"sourcesContent":["${FAKE_GOOGLE_KEY}"]}`)

    expect(scanDirectory(dist).length).toBeGreaterThan(0)
  })

  it("allows a value only by exact match, and still rejects any other key", () => {
    writeFileSync(join(dist, "assets", "firebase.js"), `var c="${FAKE_GOOGLE_KEY}";`)
    expect(scanDirectory(dist, { allowedValues: [FAKE_GOOGLE_KEY] })).toEqual([])

    const other = "AI" + "za" + "C".repeat(35)
    writeFileSync(join(dist, "assets", "other.js"), `var d="${other}";`)
    expect(scanDirectory(dist, { allowedValues: [FAKE_GOOGLE_KEY] }).length).toBe(1)
    expect(scanDirectory(dist, { allowedValues: [FAKE_GOOGLE_KEY.slice(0, 20)] }).length).toBeGreaterThan(0)
  })
})

describe("loadAllowlist", () => {
  it("is empty when the file does not exist and rejects a malformed file", () => {
    expect(loadAllowlist(join(dist, "nope.json"))).toEqual([])
    writeFileSync(join(dist, "bad.json"), '{"allowedValues": [1]}')
    expect(() => loadAllowlist(join(dist, "bad.json"))).toThrow()
  })

  it("ships an empty allowlist in the repository", () => {
    expect(loadAllowlist(resolve(__dirname, "bundle-secret-allowlist.json"))).toEqual([])
  })
})

describe("command line", () => {
  it("exits 0 on a clean build, 1 on a finding, 2 when it cannot scan", () => {
    expect(run(dist).status).toBe(0)

    writeFileSync(join(dist, "assets", "leak.js"), `var x="${FAKE_GOOGLE_KEY}";`)
    const leaked = run(dist)
    expect(leaked.status).toBe(1)
    expect(leaked.stderr).toContain("google-api-key")
    expect(leaked.stderr).not.toContain(FAKE_GOOGLE_KEY)

    expect(run(join(dist, "does-not-exist")).status).toBe(2)
  })
})
