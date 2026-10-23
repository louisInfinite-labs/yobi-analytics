import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

interface HostingHeader {
  source: string
  headers: { key: string; value: string }[]
}
interface FirebaseConfig {
  hosting: {
    public: string
    cleanUrls: boolean
    trailingSlash: boolean
    rewrites?: { source: string; destination: string }[]
    redirects?: { source: string; destination: string; type: number }[]
    headers: HostingHeader[]
  }
}

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8")
const config = JSON.parse(read("firebase.json")) as FirebaseConfig

describe("hosting config", () => {
  it("serves the generated static pages and answers an unknown route with the 404 page: no SPA catch-all rewrite (it made every path HTTP 200)", () => {
    expect(config.hosting.public).toBe("dist")
    expect(config.hosting.rewrites ?? []).toEqual([])
  })

  it("keeps extensionless URLs and no trailing slash: <path>/index.html is served at /<path> and /<path>/ redirects to it", () => {
    expect(config.hosting.cleanUrls).toBe(false)
    expect(config.hosting.trailingSlash).toBe(false)
  })

  it("redirects the duplicate /index.html and the bare /creator to the home page, and nothing else (no redirect may touch a route installed apps or push links open)", () => {
    expect(config.hosting.redirects).toEqual([
      { source: "/index.html", destination: "/", type: 301 },
      { source: "/creator", destination: "/", type: 301 },
    ])
  })

  it("serves /sitemap.xml as XML", () => {
    const rule = config.hosting.headers.find((header) => header.source === "/sitemap.xml")
    expect(rule?.headers).toContainEqual({ key: "Content-Type", value: "application/xml; charset=utf-8" })
  })

  it("revalidates every HTML route and the service worker, and keeps hashed assets immutable", () => {
    const value = (source: string, key: string) =>
      config.hosting.headers.find((header) => header.source === source)?.headers.find((h) => h.key === key)?.value
    for (const route of ["/", "/index.html", "/schedule", "/about", "/setting", "/creator/**", "/404.html", "/sw.js"]) {
      expect(value(route, "Cache-Control"), route).toBe("no-cache, max-age=0, must-revalidate")
    }
    expect(value("/sw.js", "Service-Worker-Allowed")).toBe("/")
    expect(value("/assets/**", "Cache-Control")).toBe("public, max-age=31536000, immutable")
  })

  it("gives no two Cache-Control rules overlapping sources (Firebase does not document which wins)", () => {
    const sources = config.hosting.headers.filter((header) => header.headers.some((h) => h.key === "Cache-Control")).map((header) => header.source)
    expect(new Set(sources).size).toBe(sources.length)
    expect(sources.some((source) => source === "**" || source === "/**")).toBe(false)
  })

  it("marks the private settings page and the 404 page noindex by header as well as by meta tag", () => {
    for (const route of ["/setting", "/404.html"]) {
      const rule = config.hosting.headers.find((header) => header.source === route && header.headers.some((h) => h.key === "X-Robots-Tag"))
      expect(rule?.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" })
    }
  })
})

describe("public crawler files", () => {
  it("robots.txt allows everything and names the sitemap", () => {
    const robots = read("public/robots.txt")
    expect(robots).not.toMatch(/^\s*Disallow:\s*\S/im)
    expect(robots).toMatch(/^Sitemap: https:\/\/oshiyobi\.web\.app\/sitemap\.xml$/m)
  })

  it("ships a real /favicon.ico (an ICO container), so it is no longer answered with the HTML shell", () => {
    const icon = readFileSync(resolve(process.cwd(), "public/favicon.ico"))
    expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0])
  })

  it("keeps the Google Search Console verification file", () => {
    expect(read("public/google1a6dffaa4352c009.html").trim()).toBe("google-site-verification: google1a6dffaa4352c009.html")
  })
})
