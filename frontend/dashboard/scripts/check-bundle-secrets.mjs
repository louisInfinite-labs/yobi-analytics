// SEC-FE-001 build gate: fail when the built frontend bundle contains a key-shaped string or a reference to a
// secret-bearing build variable. Browser JavaScript can never keep a secret, so this runs on `dist/` after `vite build`.
//
// Intentionally public values (for example a Firebase web-app config value) are allowed only by EXACT value, listed in
// an allowlist file (default: scripts/bundle-secret-allowlist.json, which starts empty). Findings never print the full
// matched value.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".json", ".map", ".txt", ".webmanifest"])

/** Each rule: a name and a global regex. Keep these narrow so a clean build never trips them. */
export const RULES = [
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "private-key-block", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "bearer-or-secret-assignment", pattern: /\b(?:secret|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{24,}["']/gi },
  { name: "secret-bearing-build-variable", pattern: /VITE_[A-Z0-9_]*(?:KEY|SECRET|TOKEN)[A-Z0-9_]*/g },
]

function redact(value) {
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}…(${value.length} chars)`
}

function listFiles(directory) {
  const out = []
  for (const name of readdirSync(directory)) {
    const full = join(directory, name)
    const stats = statSync(full)
    if (stats.isDirectory()) out.push(...listFiles(full))
    else if (SCANNED_EXTENSIONS.has(extname(name).toLowerCase())) out.push(full)
  }
  return out
}

/**
 * Scan every text-like file under `directory`. Returns [{ file, rule, preview }]; empty means clean.
 * `allowedValues` is the exact-value allowlist (an exact match of the matched string is skipped).
 */
export function scanDirectory(directory, { allowedValues = [] } = {}) {
  const allowed = new Set(allowedValues)
  const findings = []
  for (const file of listFiles(directory)) {
    const text = readFileSync(file, "utf8")
    for (const rule of RULES) {
      for (const match of text.matchAll(rule.pattern)) {
        if (allowed.has(match[0])) continue
        findings.push({ file, rule: rule.name, preview: redact(match[0]) })
      }
    }
  }
  return findings
}

export function loadAllowlist(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!Array.isArray(parsed.allowedValues) || !parsed.allowedValues.every((v) => typeof v === "string")) {
      throw new Error("allowedValues must be an array of strings")
    }
    return parsed.allowedValues
  } catch (error) {
    if (error && error.code === "ENOENT") return []
    throw error
  }
}

function main(argv) {
  const directory = resolve(argv[2] ?? "dist")
  const allowlistPath = resolve(argv[3] ?? join(fileURLToPath(new URL(".", import.meta.url)), "bundle-secret-allowlist.json"))
  let findings
  try {
    findings = scanDirectory(directory, { allowedValues: loadAllowlist(allowlistPath) })
  } catch (error) {
    console.error(`check-bundle-secrets: cannot scan ${directory}: ${error.message}`)
    return 2
  }
  if (findings.length === 0) {
    console.log(`check-bundle-secrets: clean (${directory})`)
    return 0
  }
  console.error(`check-bundle-secrets: ${findings.length} finding(s) in ${directory}`)
  for (const finding of findings) console.error(`  ${finding.rule}: ${finding.file} (${finding.preview})`)
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv))
}
