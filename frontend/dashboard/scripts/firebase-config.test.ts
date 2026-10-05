import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// SEC-FE-002 (P0 launch subset): the Firebase Hosting header configuration. Live verification is MT-33.
const config = JSON.parse(readFileSync(resolve(__dirname, "..", "firebase.json"), "utf8"))
const rules: { source: string; headers: { key: string; value: string }[] }[] = config.hosting.headers

function headersFor(source: string) {
  return Object.fromEntries(rules.filter((rule) => rule.source === source).flatMap((rule) => rule.headers.map((h) => [h.key, h.value])))
}

describe("firebase.json launch header subset", () => {
  it("serves the built bundle", () => {
    expect(config.hosting.public).toBe("dist")
  })

  it("sets frame protection and nosniff on every response", () => {
    const global = headersFor("**")

    expect(global["X-Content-Type-Options"]).toBe("nosniff")
    expect(global["X-Frame-Options"]).toBe("DENY")
  })

  it("makes index.html and the service worker revalidate so a security fix reaches users promptly", () => {
    expect(headersFor("/index.html")["Cache-Control"]).toBe("no-cache")
    expect(headersFor("/sw.js")["Cache-Control"]).toBe("no-cache")
  })

  it("keeps the single-page-app rewrite, which the client-side navigation needs", () => {
    expect(config.hosting.rewrites).toContainEqual({ source: "**", destination: "/index.html" })
  })

  it("does not set HSTS blindly: that is added only if the live verification shows Firebase does not already send it", () => {
    const all = rules.flatMap((rule) => rule.headers.map((h) => h.key.toLowerCase()))

    expect(all).not.toContain("strict-transport-security")
  })

  it("fabricates no Firebase project, site, origin or app identifier", () => {
    const text = readFileSync(resolve(__dirname, "..", "firebase.json"), "utf8")

    expect(text).not.toMatch(/web\.app|firebaseapp\.com|projectId|"site"|:web:/)
  })
})
