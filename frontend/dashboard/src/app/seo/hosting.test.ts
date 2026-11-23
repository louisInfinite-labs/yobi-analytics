import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { getCreatorById } from "../../entities/creator/data/creatorRegistry"
import legacy from "./legacyCreatorRoutes.json"
import { SITEMAP_PATHS } from "./sitemap"

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

  it("redirects the duplicate /index.html to the home page, then exactly the legacy creator routes -- nothing else", () => {
    const redirects = config.hosting.redirects ?? []
    expect(redirects[0]).toEqual({ source: "/index.html", destination: "/", type: 301 })
    expect(redirects.slice(1)).toEqual(legacy.routes.map(({ slug, creatorId }) => ({ source: `/creator/${slug}`, destination: `/?creator=${creatorId}`, type: 301 })))
    expect(JSON.stringify(config.hosting.headers)).not.toContain("/creator")
  })

  it("serves /sitemap.xml as XML", () => {
    const rule = config.hosting.headers.find((header) => header.source === "/sitemap.xml")
    expect(rule?.headers).toContainEqual({ key: "Content-Type", value: "application/xml; charset=utf-8" })
  })

  it("revalidates every HTML route and the service worker, and keeps hashed assets immutable", () => {
    const value = (source: string, key: string) =>
      config.hosting.headers.find((header) => header.source === source)?.headers.find((h) => h.key === key)?.value
    for (const route of ["/", "/index.html", "/schedule", "/about", "/setting", "/404.html", "/sw.js"]) {
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

describe("legacy creator redirects (retired /creator/<slug> pages)", () => {
  const redirects = (config.hosting.redirects ?? []).filter((rule) => rule.source.startsWith("/creator"))

  it("covers exactly the 119 creator pages that were live, each once", () => {
    expect(legacy.routes).toHaveLength(119)
    expect(new Set(legacy.routes.map((route) => route.slug)).size).toBe(119)
    expect(redirects).toHaveLength(119)
  })

  it("every slug names the registry creator it redirects to: an active creator whose canonical id is that slug with '-' written as '_'", () => {
    for (const { slug, creatorId } of legacy.routes) {
      const creator = getCreatorById(creatorId)
      expect(creator, slug).toBeDefined()
      expect(creator?.active, slug).toBe(true)
      expect(creatorId.replace(/_/g, "-"), slug).toBe(slug)
    }
  })

  it("only exact paths: no glob, named segment or regex, so an unknown /creator path (and bare /creator) matches nothing and stays a real 404", () => {
    for (const rule of redirects) {
      expect(rule.source, rule.source).toMatch(/^\/creator\/[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(Object.keys(rule).sort(), rule.source).toEqual(["destination", "source", "type"])
    }
    const sources = new Set(redirects.map((rule) => rule.source))
    for (const unknown of ["/creator", "/creator/", "/creator/not-a-creator", "/creator/aizawa_ema", "/creator/Aizawa-Ema"]) expect(sources.has(unknown), unknown).toBe(false)
  })

  it("redirects to the root Home with the creator id as the only parameter (Hosting appends the request's own query, e.g. ?video=<id>, with &)", () => {
    for (const rule of redirects) expect(rule.destination, rule.source).toMatch(/^\/\?creator=[a-z0-9]+(?:_[a-z0-9]+)*$/)
  })

  it("never brings a creator page back into the sitemap", () => {
    expect(SITEMAP_PATHS).toEqual(["/", "/schedule", "/about"])
  })
})
