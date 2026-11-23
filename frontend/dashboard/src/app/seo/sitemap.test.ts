import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { resolvePageSeo } from "./pageSeo"
import { buildSitemapXml, SITEMAP_ORIGIN, SITEMAP_PATHS } from "./sitemap"

describe("sitemap paths", () => {
  it("lists exactly the three indexable pages: /, /schedule and /about", () => {
    expect(SITEMAP_PATHS).toEqual(["/", "/schedule", "/about"])
  })

  it("never lists the noindex settings page, the development-only page or any creator URL", () => {
    expect(SITEMAP_PATHS).not.toContain("/setting")
    expect(SITEMAP_PATHS).not.toContain("/dashboard")
    expect(SITEMAP_PATHS.some((path) => path.startsWith("/creator"))).toBe(false)
  })

  it("every listed page is a served, indexable page", () => {
    for (const path of SITEMAP_PATHS) expect(resolvePageSeo(path)?.indexable, path).toBe(true)
  })
})

describe("sitemap xml", () => {
  const xml = buildSitemapXml()

  it("is well-formed XML with one https <loc> per page and no <lastmod>", () => {
    const doc = new DOMParser().parseFromString(xml, "application/xml")
    expect(doc.querySelector("parsererror")).toBeNull()
    const locs = [...doc.getElementsByTagName("loc")].map((el) => el.textContent)
    expect(locs).toEqual(["https://oshiyobi.web.app/", "https://oshiyobi.web.app/schedule", "https://oshiyobi.web.app/about"])
    expect(xml).not.toContain("lastmod")
    expect(xml).not.toContain("/creator")
  })
})

describe("robots.txt", () => {
  it("points crawlers at the sitemap", () => {
    const robots = readFileSync(resolve(process.cwd(), "public/robots.txt"), "utf8")
    expect(robots).toContain(`Sitemap: ${SITEMAP_ORIGIN}/sitemap.xml`)
  })
})
