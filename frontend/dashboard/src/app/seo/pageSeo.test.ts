import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { getCreators } from "../../entities/creator/data/creatorRegistry"
import { creatorPath } from "../navigation/creatorRoutes"
import {
  buildHomeJsonLd,
  buildStaticBody,
  escapeHtml,
  NOT_FOUND_SEO,
  pageFileName,
  renderSeoPage,
  resolvePageSeo,
  type PageSeo,
  type SeoCreator,
} from "./pageSeo"
import { buildSitemapPaths, SITEMAP_ORIGIN } from "./sitemap"

const creators: readonly SeoCreator[] = getCreators()
const sitemapPaths = buildSitemapPaths(creators)
/** The built shell, as Vite's html plugin leaves it: index.html with the hashed tags added (stubbed here). */
const shell = readFileSync(resolve(process.cwd(), "index.html"), "utf8").replace("</body>", '  <script type="module" src="/assets/index-test.js"></script>\n  </body>')
const seoOf = (path: string): PageSeo => {
  const seo = resolvePageSeo(path, creators)
  if (!seo) throw new Error(`no seo for ${path}`)
  return seo
}
const render = (path: string) => renderSeoPage(shell, seoOf(path), creators)
const head = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"))
const body = (html: string) => html.slice(html.indexOf("<body>"))
const attr = (html: string, pattern: RegExp) => html.match(pattern)?.[1]

describe("page set", () => {
  it("has SEO metadata for every sitemap path, and for /setting (which the sitemap leaves out)", () => {
    for (const path of [...sitemapPaths, "/setting"]) expect(resolvePageSeo(path, creators), path).not.toBeNull()
    expect(sitemapPaths).not.toContain("/setting")
  })

  it("writes every page to its own file: / is index.html, any other path <path>/index.html, with no collision", () => {
    expect(pageFileName("/")).toBe("index.html")
    expect(pageFileName("/creator/kurumi-noa")).toBe("creator/kurumi-noa/index.html")
    const files = [...sitemapPaths, "/setting"].map(pageFileName)
    expect(new Set(files).size).toBe(files.length)
  })

  it("covers exactly the Creators the app's router resolves, under the router's own path", () => {
    const creatorPaths = sitemapPaths.filter((path) => path.startsWith("/creator/"))
    expect(creatorPaths).toEqual(creators.filter((creator) => creator.active).map(creatorPath).sort())
  })

  it("does not resolve an unknown route, an inactive creator or a bare /creator (those get the 404 page / a redirect)", () => {
    expect(resolvePageSeo("/nonexistent-page", creators)).toBeNull()
    expect(resolvePageSeo("/creator/does-not-exist-xyz", creators)).toBeNull()
    expect(resolvePageSeo("/creator", creators)).toBeNull()
    expect(resolvePageSeo("/creator/", creators)).toBeNull()
    expect(resolvePageSeo("/dashboard", creators)).toBeNull()
    expect(resolvePageSeo("/creator/gone", [{ ...creators[0], creatorId: "gone", active: false }])).toBeNull()
  })

  it("ignores a trailing slash like the router does", () => {
    expect(resolvePageSeo("/creator/kurumi-noa/", creators)?.path).toBe("/creator/kurumi-noa")
    expect(resolvePageSeo("/schedule/", creators)?.path).toBe("/schedule")
  })
})

describe("titles, descriptions and canonicals", () => {
  const all = [...sitemapPaths, "/setting"].map(seoOf)

  it("gives every page a unique, non-empty title and a distinct description", () => {
    expect(new Set(all.map((seo) => seo.title)).size).toBe(all.length)
    expect(new Set(all.map((seo) => seo.description)).size).toBe(all.length)
    for (const seo of all) {
      expect(seo.title.length, seo.path).toBeGreaterThan(5)
      expect(seo.description.length, seo.path).toBeGreaterThan(30)
    }
  })

  it("keeps descriptions a snippet-friendly length", () => {
    for (const seo of all) expect(seo.description.length, `${seo.path}: ${seo.description}`).toBeLessThanOrEqual(220)
  })

  it("canonicalises every sitemap page to exactly its sitemap URL on the official host", () => {
    for (const path of sitemapPaths) expect(seoOf(path).canonicalUrl, path).toBe(`${SITEMAP_ORIGIN}${path}`)
  })

  it("names the creator in the title and description of a creator page", () => {
    const noa = seoOf("/creator/kurumi-noa")
    expect(noa.title).toContain("胡桃のあ")
    expect(noa.description).toContain("胡桃のあ")
    expect(noa.description).toContain("VSPO JP member")
  })

  it("indexes every public page and keeps /setting out", () => {
    for (const path of sitemapPaths) expect(seoOf(path).indexable, path).toBe(true)
    expect(seoOf("/setting").indexable).toBe(false)
    expect(NOT_FOUND_SEO.indexable).toBe(false)
    expect(NOT_FOUND_SEO.canonicalUrl).toBeNull()
  })

  it("words graduated and pre-debut creators from the registry's lifecycle stage, without inventing a biography", () => {
    const graduated = creators.find((creator) => creator.lifecycleStage === "graduated" && creator.active)!
    const preDebut = creators.find((creator) => creator.lifecycleStage === "pre_debut" && creator.active)!
    expect(seoOf(creatorPath(graduated)).title).toContain("graduated")
    expect(seoOf(creatorPath(graduated)).description).toContain("graduated")
    expect(seoOf(creatorPath(preDebut)).description).toContain("pre-debut")
    const text = buildStaticBody(seoOf(creatorPath(graduated)), creators)
    expect(text).toContain("no longer collects new content")
  })
})

describe("rendered pages", () => {
  it("puts the page's own title, description, canonical, og tags and charset in <head>, once each", () => {
    const html = render("/creator/usada-pekora")
    const h = head(html)
    expect(h).toContain('<meta charset="UTF-8" />')
    expect(h.match(/<title>/g)).toHaveLength(1)
    expect(attr(h, /<title>([^<]*)<\/title>/)).toBe("兎田ぺこら – Live status, schedule &amp; videos | OshiYobi")
    expect(h.match(/rel="canonical"/g)).toHaveLength(1)
    expect(attr(h, /rel="canonical" href="([^"]+)"/)).toBe("https://oshiyobi.web.app/creator/usada-pekora")
    expect(attr(h, /property="og:url" content="([^"]+)"/)).toBe("https://oshiyobi.web.app/creator/usada-pekora")
    expect(h.match(/name="description"/g)).toHaveLength(1)
    expect(h).toContain('property="og:site_name" content="OshiYobi"')
    expect(h).not.toContain('name="robots"')
  })

  it("keeps the shell intact: the manifest, icons, iOS metadata and the app's script", () => {
    const html = render("/schedule")
    for (const keep of ['rel="manifest" href="/manifest.webmanifest"', 'rel="apple-touch-icon"', "apple-mobile-web-app-capable", "/assets/index-test.js"]) expect(html).toContain(keep)
  })

  it("puts indexable text and crawlable links inside #root (visible until React mounts, then replaced), not an empty root", () => {
    const html = render("/creator/kurumi-noa")
    const b = body(html)
    expect(b).not.toContain('<div id="root"></div>')
    expect(b).toContain('<div id="root"><main data-seo-static>')
    expect(b).not.toMatch(/clip:|clip-path|position:absolute|display:none|visibility:hidden|\bhidden\b/) // no hidden, SEO-only copy
    expect(b).toContain('<h1><span lang="ja">胡桃のあ</span></h1>')
    expect(b).toContain("VSPO JP member")
    expect(b).toContain('<a href="/">OshiYobi home</a>')
    expect(b).toContain('<a href="/schedule">Live schedule</a>')
    expect(b).toContain('<a href="/about">About</a>')
    expect(b).toContain('<a href="/creator/aizawa-ema">')
    expect(b).toContain("https://www.youtube.com/channel/UCIcAj6WkJ8vZ7DeJVgmeqKw")
    expect(b).not.toContain('href="/creator/kurumi-noa"') // no self-link
  })

  it("links the home page to every creator, grouped by branch", () => {
    const b = body(render("/"))
    for (const creator of creators.filter((c) => c.active)) expect(b, creator.creatorId).toContain(`<a href="${creatorPath(creator)}">`)
    expect(b).toContain("<h3>Hololive JP</h3>")
    expect(b).toContain("<h3>VSPO EN</h3>")
    expect(b).toContain("<h1>OshiYobi – 推しが呼んでる。</h1>")
  })

  it("never links to a page the site does not serve (internal hrefs all resolve)", () => {
    const served = new Set([...sitemapPaths, "/setting"])
    for (const path of sitemapPaths) {
      for (const [, href] of body(render(path)).matchAll(/href="(\/[^"]*)"/g)) expect(served.has(href), `${path} -> ${href}`).toBe(true)
    }
  })

  it("gives the home page WebSite JSON-LD and no other page any", () => {
    expect(head(render("/"))).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"OshiYobi","url":"https://oshiyobi.web.app/"}</script>')
    expect(JSON.parse(buildHomeJsonLd()).url).toBe("https://oshiyobi.web.app/")
    for (const path of sitemapPaths.filter((p) => p !== "/")) expect(head(render(path)), path).not.toContain("ld+json")
  })

  it("marks /setting and the 404 page noindex with no canonical on the 404 page", () => {
    expect(head(render("/setting"))).toContain('<meta name="robots" content="noindex, nofollow" />')
    const notFound = renderSeoPage(shell, NOT_FOUND_SEO, creators)
    expect(head(notFound)).toContain('<meta name="robots" content="noindex, nofollow" />')
    expect(head(notFound)).not.toContain('rel="canonical"')
    expect(body(notFound)).toContain("Page not found")
  })

  it("renders every page without leaving a template placeholder or an unescaped Creator string", () => {
    for (const path of [...sitemapPaths, "/setting"]) {
      const html = render(path)
      expect(html, path).not.toMatch(/undefined|\[object|\$\{/)
      expect(html.match(/<h1>/g), path).toHaveLength(1)
    }
  })

  it("fails the build, instead of emitting a page without SEO, when the shell lost its <title> or empty #root", () => {
    const creator = creators[0]
    const seo = seoOf(creatorPath(creator))
    expect(() => renderSeoPage(shell.replace("<title>OshiYobi</title>", ""), seo, creators)).toThrow(/lacks/)
    expect(() => renderSeoPage(shell.replace('<div id="root"></div>', '<div id="root"><p>x</p></div>'), seo, creators)).toThrow(/lacks/)
  })
})

describe("escaping", () => {
  const nasty: SeoCreator = {
    ...creators[0],
    creatorId: "nasty_one",
    displayName: `A<script>alert("x")</script> & 'B' ぺこ</title>`,
    groupKey: ["<b>gen</b>"],
    avatarUrl: 'https://example.com/a.png"onerror="x',
    youtubeChannelId: 'UC"><x',
  }
  const all = [...creators, nasty]
  const html = renderSeoPage(shell, resolvePageSeo("/creator/nasty-one", all)!, all)

  it("escapes a Creator's name in the title, meta tags and body", () => {
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("</title>ぺこ")
    expect(html).toContain("A&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;B&#39; ぺこ&lt;/title&gt;")
    expect(html).not.toContain('onerror="x"')
    expect(html).toContain("&lt;b&gt;gen&lt;/b&gt;")
    expect(html).not.toContain('UC"><x')
    expect(html).toContain("UC%22%3E%3Cx")
  })

  it("keeps Japanese text, full-width and special characters intact (UTF-8, not entities)", () => {
    const vspo = render("/creator/vspo-official")
    expect(vspo).toContain("ぶいすぽっ!【公式】")
    const inanis = creators.find((creator) => creator.creatorId === "ninomae_inanis")!
    expect(render("/creator/ninomae-inanis")).toContain(escapeHtml(inanis.displayName))
  })

  it("the home JSON-LD cannot close its script tag", () => {
    expect(buildHomeJsonLd()).not.toContain("<")
  })
})

describe("PWA identity (unchanged by the SEO pages)", () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8"))
  it("keeps the manifest id, start_url, scope and display that installed apps were created with", () => {
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", name: "OshiYobi" })
  })
  it("start_url and the push deep-link destinations are all served pages", () => {
    const served = new Set(sitemapPaths)
    expect(served.has(manifest.start_url)).toBe(true)
    expect(served.has("/creator/kurumi-noa")).toBe(true)
  })
  it("the service worker still has no fetch handler and no cache, so a new HTML never meets a stale cached copy", () => {
    const sw = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8")
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/)
    expect(sw).not.toMatch(/caches\./)
  })
})
