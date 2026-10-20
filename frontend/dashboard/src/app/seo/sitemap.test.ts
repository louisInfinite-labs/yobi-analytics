import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { getCreators } from "../../entities/creator/data/creatorRegistry"
import { creatorPath, parseCreatorRoute } from "../navigation/creatorRoutes"
import { CREATOR_SLUG_PATTERN, creatorIdToSlug, isCanonicalCreatorId } from "../navigation/creatorSlugRule"
import { buildSitemapPaths, buildSitemapXml, SITEMAP_ORIGIN } from "./sitemap"

const paths = buildSitemapPaths(getCreators())

describe("sitemap paths", () => {
  it("lists the public fixed pages and never the private or development-only ones", () => {
    expect(paths.slice(0, 3)).toEqual(["/", "/schedule", "/about"])
    expect(paths).not.toContain("/dashboard")
    expect(paths).not.toContain("/setting")
    expect(paths.every((path) => !path.includes("?") && !path.includes("#"))).toBe(true)
  })

  it("has no duplicates", () => {
    expect(new Set(paths).size).toBe(paths.length)
  })

  it("lists exactly the creators the router resolves, under the router's own slug", () => {
    const expected = getCreators().filter((c) => c.active).map(creatorPath).sort()
    expect(paths.slice(3)).toEqual(expected)
    for (const path of paths.slice(3)) expect(parseCreatorRoute(path)?.kind, path).toBe("creator")
  })

  it("keeps graduated creators, whose Home route still resolves", () => {
    const graduated = getCreators().filter((c) => c.lifecycleStage === "graduated" && c.active)
    expect(graduated.length).toBeGreaterThan(0)
    for (const creator of graduated) expect(paths).toContain(creatorPath(creator))
  })

  it("skips an inactive creator, which the router does not resolve", () => {
    expect(buildSitemapPaths([{ creatorId: "gone_creator", active: false }])).toEqual(["/", "/schedule", "/about"])
  })

  it("fails the build on a creatorId the router could not resolve, instead of leaving it out", () => {
    for (const bad of ["Aizawa_Ema", "aizawa__ema", "_aizawa", "aizawa_", "aizawa-ema", "aizawa ema", "aizawa/ema", "aizawa?x=1", "藍沢", "a&b", ""]) {
      expect(() => buildSitemapPaths([{ creatorId: "aizawa_ema", active: true }, { creatorId: bad, active: true }]), JSON.stringify(bad)).toThrow(
        /non-canonical creatorId/,
      )
    }
  })

  it("also rejects a non-canonical creatorId on an inactive creator (a corrupt registry is not silently trusted)", () => {
    expect(() => buildSitemapPaths([{ creatorId: "Bad_Id", active: false }])).toThrow(/non-canonical creatorId/)
  })

  it("fails the build on a repeated creator slug instead of de-duplicating it", () => {
    const twice = [{ creatorId: "aizawa_ema", active: true }, { creatorId: "aizawa_ema", active: true }]
    expect(() => buildSitemapPaths(twice)).toThrow(/duplicate creator slug in the Creator Registry: aizawa-ema/)
  })

  it("every canonical id yields a slug the router's own pattern accepts, and every registry id is canonical", () => {
    for (const id of ["a", "a1", "a_b", "a_b_c1"]) expect(CREATOR_SLUG_PATTERN.test(creatorIdToSlug(id)), id).toBe(true)
    for (const creator of getCreators()) expect(isCanonicalCreatorId(creator.creatorId), creator.creatorId).toBe(true)
  })
})

describe("sitemap xml", () => {
  const xml = buildSitemapXml(paths)

  it("is well-formed XML with one https <loc> per path and no <lastmod>", () => {
    const doc = new DOMParser().parseFromString(xml, "application/xml")
    expect(doc.querySelector("parsererror")).toBeNull()
    const locs = [...doc.getElementsByTagName("loc")].map((el) => el.textContent)
    expect(locs).toEqual(paths.map((path) => `${SITEMAP_ORIGIN}${path}`))
    expect(locs.every((loc) => loc!.startsWith("https://oshiyobi.web.app/"))).toBe(true)
    expect(xml).not.toContain("lastmod")
  })
})

describe("robots.txt", () => {
  it("points crawlers at the sitemap", () => {
    const robots = readFileSync(resolve(process.cwd(), "public/robots.txt"), "utf8")
    expect(robots).toContain(`Sitemap: ${SITEMAP_ORIGIN}/sitemap.xml`)
  })
})
