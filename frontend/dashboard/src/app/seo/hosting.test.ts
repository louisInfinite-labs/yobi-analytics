import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

interface HostingHeader {
  source: string
  headers: { key: string; value: string }[]
}
interface FirebaseConfig {
  hosting: { public: string; rewrites: { source: string; destination: string }[]; headers: HostingHeader[] }
}

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8")
const config = JSON.parse(read("firebase.json")) as FirebaseConfig

describe("hosting config for the sitemap", () => {
  it("keeps the SPA catch-all rewrite, which Firebase applies only after static files (so dist/sitemap.xml and robots.txt win)", () => {
    expect(config.hosting.public).toBe("dist")
    expect(config.hosting.rewrites).toEqual([{ source: "**", destination: "/index.html" }])
  })

  it("serves /sitemap.xml as XML", () => {
    const rule = config.hosting.headers.find((header) => header.source === "/sitemap.xml")
    expect(rule?.headers).toContainEqual({ key: "Content-Type", value: "application/xml; charset=utf-8" })
  })

  it("leaves the existing index.html, sw.js and assets caching rules untouched", () => {
    const value = (source: string, key: string) =>
      config.hosting.headers.find((header) => header.source === source)?.headers.find((h) => h.key === key)?.value
    expect(value("/index.html", "Cache-Control")).toBe("no-cache, max-age=0, must-revalidate")
    expect(value("/sw.js", "Cache-Control")).toBe("no-cache, max-age=0, must-revalidate")
    expect(value("/sw.js", "Service-Worker-Allowed")).toBe("/")
    expect(value("/assets/**", "Cache-Control")).toBe("public, max-age=31536000, immutable")
  })
})

describe("public crawler files", () => {
  it("robots.txt allows everything and names the sitemap", () => {
    const robots = read("public/robots.txt")
    expect(robots).not.toMatch(/^\s*Disallow:\s*\S/im)
    expect(robots).toMatch(/^Sitemap: https:\/\/oshiyobi\.web\.app\/sitemap\.xml$/m)
  })

  it("keeps the Google Search Console verification file", () => {
    expect(read("public/google1a6dffaa4352c009.html").trim()).toBe("google-site-verification: google1a6dffaa4352c009.html")
  })
})
