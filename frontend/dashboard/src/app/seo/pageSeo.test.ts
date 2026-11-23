import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { buildHomeJsonLd, NOT_FOUND_SEO, pageFileName, renderSeoPage, resolvePageSeo, SEO_PAGE_PATHS, type PageSeo } from "./pageSeo"
import { SITEMAP_ORIGIN, SITEMAP_PATHS } from "./sitemap"

/** The built shell, as Vite's html plugin leaves it: index.html with the hashed tags added (stubbed here). */
const shell = readFileSync(resolve(process.cwd(), "index.html"), "utf8").replace("</body>", '  <script type="module" src="/assets/index-test.js"></script>\n  </body>')
const seoOf = (path: string): PageSeo => {
  const seo = resolvePageSeo(path)
  if (!seo) throw new Error(`no seo for ${path}`)
  return seo
}
const render = (path: string) => renderSeoPage(shell, seoOf(path))
const head = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"))
const body = (html: string) => html.slice(html.indexOf("<body>"))
const attr = (html: string, pattern: RegExp) => html.match(pattern)?.[1]
const allPages = [...SEO_PAGE_PATHS, "404"].map((path) => (path === "404" ? renderSeoPage(shell, NOT_FOUND_SEO) : render(path)))

describe("page set", () => {
  it("is exactly the sitemap's three indexable pages plus the noindex settings page", () => {
    expect(SEO_PAGE_PATHS).toEqual([...SITEMAP_PATHS, "/setting"])
    for (const path of SEO_PAGE_PATHS) expect(resolvePageSeo(path), path).not.toBeNull()
  })

  it("writes every page to its own file: / is index.html, any other path <path>/index.html, with no collision", () => {
    expect(SEO_PAGE_PATHS.map(pageFileName)).toEqual(["index.html", "schedule/index.html", "about/index.html", "setting/index.html"])
  })

  it("has no creator pages: every /creator URL, an unknown route and the dev-only page resolve to nothing (the host's 404)", () => {
    for (const path of ["/creator/aizawa-ema", "/creator/kurumi-noa/", "/creator", "/creator/", "/nonexistent-page", "/dashboard"]) {
      expect(resolvePageSeo(path), path).toBeNull()
    }
  })

  it("ignores a trailing slash", () => {
    expect(resolvePageSeo("/schedule/")?.path).toBe("/schedule")
  })
})

describe("titles, descriptions and canonicals", () => {
  const all = SEO_PAGE_PATHS.map(seoOf)

  it("gives every page a unique, non-empty title and a distinct, snippet-friendly description", () => {
    expect(new Set(all.map((seo) => seo.title)).size).toBe(all.length)
    expect(new Set(all.map((seo) => seo.description)).size).toBe(all.length)
    for (const seo of all) {
      expect(seo.title.length, seo.path).toBeGreaterThan(5)
      expect(seo.description.length, seo.path).toBeGreaterThan(30)
      expect(seo.description.length, seo.path).toBeLessThanOrEqual(220)
    }
  })

  it("canonicalises every sitemap page to exactly its sitemap URL on the official host; /setting and the 404 page are noindex", () => {
    for (const path of SITEMAP_PATHS) {
      expect(seoOf(path).canonicalUrl, path).toBe(`${SITEMAP_ORIGIN}${path}`)
      expect(seoOf(path).indexable, path).toBe(true)
    }
    expect(seoOf("/setting").indexable).toBe(false)
    expect(NOT_FOUND_SEO.indexable).toBe(false)
    expect(NOT_FOUND_SEO.canonicalUrl).toBeNull()
  })

  it("names the site, not a creator, on the home page", () => {
    expect(seoOf("/").title).toBe("OshiYobi – VTuber live status, schedule & new videos")
  })
})

describe("rendered pages", () => {
  it("puts the page's own title, description, canonical, og tags and charset in <head>, once each", () => {
    const h = head(render("/schedule"))
    expect(h).toContain('<meta charset="UTF-8" />')
    expect(h.match(/<title>/g)).toHaveLength(1)
    expect(attr(h, /<title>([^<]*)<\/title>/)).toBe("Live schedule | OshiYobi")
    expect(h.match(/rel="canonical"/g)).toHaveLength(1)
    expect(attr(h, /rel="canonical" href="([^"]+)"/)).toBe("https://oshiyobi.web.app/schedule")
    expect(attr(h, /property="og:url" content="([^"]+)"/)).toBe("https://oshiyobi.web.app/schedule")
    expect(h.match(/name="description"/g)).toHaveLength(1)
    expect(h).toContain('property="og:site_name" content="OshiYobi"')
    expect(h).not.toContain('name="robots"')
  })

  it("keeps the shell intact: the manifest, icons, iOS metadata and the app's script", () => {
    const html = render("/schedule")
    for (const keep of ['rel="manifest" href="/manifest.webmanifest"', 'rel="apple-touch-icon"', "apple-mobile-web-app-capable", "/assets/index-test.js"]) expect(html).toContain(keep)
  })

  it("the home page: the site's name as its one <h1>, what it is and offers, and the site links -- no creator list", () => {
    const b = body(render("/"))
    expect(b).toContain('<div id="root"><main data-seo-static>')
    expect(b).not.toMatch(/clip:|clip-path|position:absolute|display:none|visibility:hidden|\bhidden\b/) // no hidden, SEO-only copy
    expect(b.match(/<h1>/g)).toHaveLength(1)
    expect(b).toContain("<h1>OshiYobi – 推しが呼んでる。</h1>")
    expect(b).toContain("Live Status: see who is live or about to go live")
    expect(b).toContain('<a href="/">OshiYobi home</a>')
    expect(b).toContain('<a href="/schedule">Live schedule</a>')
    expect(b).toContain('<a href="/about">About</a>')
  })

  it("no generated page links, canonicalises or points structured data at a creator URL", () => {
    for (const html of allPages) {
      expect(html).not.toMatch(/\/creator\b/)
    }
  })

  it("every internal href resolves to a served page", () => {
    for (const html of allPages) {
      for (const [, href] of body(html).matchAll(/href="(\/[^"]*)"/g)) expect(SEO_PAGE_PATHS.includes(href), href).toBe(true)
    }
  })

  it("gives the home page WebSite JSON-LD and no other page any", () => {
    expect(head(render("/"))).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"OshiYobi","url":"https://oshiyobi.web.app/"}</script>')
    expect(JSON.parse(buildHomeJsonLd()).url).toBe("https://oshiyobi.web.app/")
    expect(buildHomeJsonLd()).not.toContain("<")
    for (const path of SEO_PAGE_PATHS.filter((p) => p !== "/")) expect(head(render(path)), path).not.toContain("ld+json")
  })

  it("marks /setting and the 404 page noindex with no canonical on the 404 page", () => {
    expect(head(render("/setting"))).toContain('<meta name="robots" content="noindex, nofollow" />')
    const notFound = renderSeoPage(shell, NOT_FOUND_SEO)
    expect(head(notFound)).toContain('<meta name="robots" content="noindex, nofollow" />')
    expect(head(notFound)).not.toContain('rel="canonical"')
    expect(body(notFound)).toContain("Page not found")
  })

  it("renders every page without leaving a template placeholder, with exactly one <h1>", () => {
    for (const html of allPages) {
      expect(html).not.toMatch(/undefined|\[object|\$\{/)
      expect(html.match(/<h1>/g)).toHaveLength(1)
    }
  })

  it("fails the build, instead of emitting a page without SEO, when the shell lost its <title> or empty #root", () => {
    expect(() => renderSeoPage(shell.replace("<title>OshiYobi</title>", ""), seoOf("/"))).toThrow(/lacks/)
    expect(() => renderSeoPage(shell.replace('<div id="root"></div>', '<div id="root"><p>x</p></div>'), seoOf("/"))).toThrow(/lacks/)
  })
})

describe("About page: raw HTML and rendered content say the same facts", () => {
  /** The first line of an About content file: the opening sentence the running page renders. */
  const aboutOpening = (locale: string) => {
    const lines = readFileSync(resolve(process.cwd(), `../../src/content/about/${locale}/about.md`), "utf8").split(/\r?\n/)
    return lines[4]
  }
  const html = render("/about")

  it("the static HTML names Hololive and VSPO! as the supported groups, in the body and the meta description, and implies no others", () => {
    const sentence = "OshiYobi (推し呼び) is a website for checking livestream information from Hololive and VSPO! VTubers."
    expect(body(html)).toContain(`<p>${sentence}</p>`)
    expect(head(html)).toContain(`<meta name="description" content="${sentence}" />`)
    expect(sentence).not.toMatch(/such as|and more|など|等|etc/i)
  })

  it("is exactly the opening sentence of the English About content the running page renders", () => {
    expect(body(html)).toContain(`<p>${aboutOpening("en")}</p>`)
  })

  it("the Japanese and Traditional Chinese About content open by naming the same two groups", () => {
    expect(aboutOpening("ja")).toContain("ホロライブとぶいすぽっ！")
    expect(aboutOpening("zh-TW")).toContain("Hololive 與ぶいすぽっ！（VSPO!）")
    for (const locale of ["ja", "zh-TW", "en"]) expect(aboutOpening(locale), locale).not.toMatch(/such as|and more|など|等/)
  })
})

describe("PWA identity (unchanged by the SEO pages)", () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8"))
  it("keeps the manifest id, start_url, scope and display that installed apps were created with", () => {
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", name: "OshiYobi" })
  })
  it("start_url and the push deep-link destination (the root Home) are served pages", () => {
    expect(SEO_PAGE_PATHS.includes(manifest.start_url)).toBe(true)
    expect(SEO_PAGE_PATHS.includes("/")).toBe(true)
  })
  it("the service worker still has no fetch handler and no cache, so a new HTML never meets a stale cached copy", () => {
    const sw = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8")
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/)
    expect(sw).not.toMatch(/caches\./)
  })
})
