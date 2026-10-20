import { creatorIdToSlug, isCanonicalCreatorId } from "../navigation/creatorSlugRule.ts"

/** Build-time sitemap for Google Search Console (emitted into dist/sitemap.xml by the sitemap plugin in vite.config.ts). It imports only the
 * dependency-free slug rule shared with the router, so the Vite config (a Node context) can load it without the app's registry module; the full
 * parity with the app's real routing (app/navigation/creatorRoutes.ts) is pinned by sitemap.test.ts. */
export const SITEMAP_ORIGIN = "https://oshiyobi.web.app"

/** The public, fixed pages. "/dashboard" is development-only and "/setting" is a private settings page, so neither is listed. */
export const STATIC_SITEMAP_PATHS: readonly string[] = ["/", "/schedule", "/about"]

export interface SitemapCreator {
  creatorId: string
  active: boolean
}

/** The ordered list of public paths: the fixed pages, then one /creator/<slug> per active registry creator (the router's own rule: an inactive
 * or unknown creator never resolves to a creator Home). Graduated creators stay listed while their Home route resolves. The slug comes from the
 * router's own rule (creatorSlugRule.ts). Throws -- failing the build -- on a registry creatorId that is not canonical, or that repeats, rather
 * than silently leaving a creator out or emitting a URL the router would not resolve. */
export function buildSitemapPaths(creators: readonly SitemapCreator[]): string[] {
  const invalid = creators.filter((creator) => !isCanonicalCreatorId(creator.creatorId)).map((creator) => JSON.stringify(creator.creatorId))
  if (invalid.length > 0) throw new Error(`sitemap: non-canonical creatorId in the Creator Registry: ${invalid.join(", ")}`)

  const slugs = creators.filter((creator) => creator.active).map((creator) => creatorIdToSlug(creator.creatorId))
  const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index)
  if (duplicates.length > 0) throw new Error(`sitemap: duplicate creator slug in the Creator Registry: ${[...new Set(duplicates)].join(", ")}`)

  return [...STATIC_SITEMAP_PATHS, ...slugs.map((slug) => `/creator/${slug}`).sort()]
}

/** The sitemap XML for the given paths. No <lastmod>: no accurate per-page modification date exists, and a wrong one is worse than none. */
export function buildSitemapXml(paths: readonly string[], origin: string = SITEMAP_ORIGIN): string {
  const entries = paths.map((path) => `  <url>\n    <loc>${origin}${path}</loc>\n  </url>`).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
}
