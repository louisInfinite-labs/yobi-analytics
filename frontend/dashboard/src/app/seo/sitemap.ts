/** Build-time sitemap for Google Search Console (emitted into dist/sitemap.xml by the sitemap plugin in vite.config.ts). Dependency-free, so the
 * Vite config (a Node context) can load it. */
export const SITEMAP_ORIGIN = "https://oshiyobi.web.app"

/** The site's indexable pages -- the only URLs the sitemap lists. "/setting" is a private settings page (noindex) and "/dashboard" is
 * development-only, so neither is listed. Which creator Home shows is in-app state, never a URL of its own. */
export const SITEMAP_PATHS: readonly string[] = ["/", "/schedule", "/about"]

/** The sitemap XML for the given paths. No <lastmod>: no accurate per-page modification date exists, and a wrong one is worse than none. */
export function buildSitemapXml(paths: readonly string[] = SITEMAP_PATHS, origin: string = SITEMAP_ORIGIN): string {
  const entries = paths.map((path) => `  <url>\n    <loc>${origin}${path}</loc>\n  </url>`).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
}
