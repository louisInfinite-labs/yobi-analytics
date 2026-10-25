/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { configDefaults } from 'vitest/config'
import { buildSitemapPaths, buildSitemapXml, STATIC_SITEMAP_PATHS } from './src/app/seo/sitemap.ts'
import { apiPreconnectTags } from './src/app/seo/apiPreconnect.ts'
import { NOT_FOUND_SEO, pageFileName, renderSeoPage, resolvePageSeo, type SeoCreator } from './src/app/seo/pageSeo.ts'

/** The Creator Registry's creators, read from the generated JSON the app's router resolves slugs from. */
function readRegistryCreators(): SeoCreator[] {
  const registryPath = fileURLToPath(new URL('./src/entities/creator/data/generated/creatorMaster.json', import.meta.url))
  return (JSON.parse(readFileSync(registryPath, 'utf8')) as { creators: SeoCreator[] }).creators
}

/** Emits dist/sitemap.xml at build time from the generated Creator Registry (the same file the app's router resolves /creator/:slug from), so
 * the sitemap can never drift from the roster and needs no runtime or API call. Build only; dev and tests are unaffected. */
function sitemapPlugin(): Plugin {
  return {
    name: 'oshiyobi-sitemap',
    apply: 'build',
    generateBundle() {
      const paths = buildSitemapPaths(readRegistryCreators())
      if (paths.length <= STATIC_SITEMAP_PATHS.length) throw new Error('sitemap: the Creator Registry produced no creator URLs')
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: buildSitemapXml(paths) })
    },
  }
}

/** Adds one `<link rel="preconnect" crossorigin>` for the API origin to the built HTML, so the browser (and a crawler's renderer) opens that connection while
 * the bundle downloads instead of after it starts. The origin comes from the build's own VITE_API_BASE_URL; with none configured (or an unusable one) no
 * tag is added. The static SEO pages are rendered from this HTML, so every page carries it. Build only. */
function apiPreconnectPlugin(): Plugin {
  let apiBaseUrl: unknown
  return {
    name: 'oshiyobi-api-preconnect',
    apply: 'build',
    configResolved(config) {
      apiBaseUrl = config.env.VITE_API_BASE_URL
    },
    transformIndexHtml: () => apiPreconnectTags(apiBaseUrl),
  }
}

/** Static SEO pages, generated from the built index.html (so every page carries the real hashed script/style tags): one HTML file per public route
 * (/ -> index.html, /schedule, /about, /setting, and /creator/<slug> for every sitemap Creator -> <path>/index.html, which Firebase Hosting serves
 * at the extensionless URL) plus 404.html for unknown routes. Each file has its own title/description/canonical/Open Graph tags and real text and
 * links inside #root; React replaces that on first render. The page set is the sitemap's own path list plus /setting, so sitemap and pages cannot
 * disagree. Runs after Vite's html plugin (enforce: 'post') so it sees the final index.html. */
function seoPagesPlugin(): Plugin {
  return {
    name: 'oshiyobi-seo-pages',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const shellAsset = bundle['index.html']
      if (!shellAsset || shellAsset.type !== 'asset') throw new Error('seo: the built index.html was not found in the bundle')
      const shell = String(shellAsset.source)
      const creators = readRegistryCreators()
      const paths = [...buildSitemapPaths(creators), '/setting']
      for (const path of paths) {
        const seo = resolvePageSeo(path, creators)
        if (!seo) throw new Error(`seo: ${path} has no page metadata`)
        const source = renderSeoPage(shell, seo, creators)
        if (path === '/') shellAsset.source = source
        else this.emitFile({ type: 'asset', fileName: pageFileName(path), source })
      }
      this.emitFile({ type: 'asset', fileName: '404.html', source: renderSeoPage(shell, NOT_FOUND_SEO, creators) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiPreconnectPlugin(), sitemapPlugin(), seoPagesPlugin()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Browser-verification tooling prerequisite (MT-16/MT-17): Playwright's
    // own suite lives in ./e2e and must not be picked up by Vitest's
    // default include glob, which would otherwise try to run
    // `@playwright/test` specs through the jsdom runner. Vitest's own
    // default `exclude` list (node_modules, dist, .git, etc.) is additive
    // via `configDefaults.exclude`, not replaced, so nothing already
    // excluded becomes scannable again.
    exclude: [...configDefaults.exclude, '**/e2e/**'],
    // Vitest's own default worker count scales with the host's logical CPU
    // count (this repo's own dev/CI machines report 32), spawning that many
    // separate forked processes -- each independently loading this suite's
    // full jsdom + antd/recharts/gridstack/dnd-kit import graph. Confirmed
    // by direct measurement: the full suite is 100% green and reproducible
    // at 4 workers, but at the unbounded default it intermittently times out
    // (5000ms) on an arbitrary handful of otherwise-passing tests under
    // full-suite load -- each one passes cleanly in isolation, so this is
    // memory/CPU contention between workers, not a leak or a slow test.
    // Fixed at a known-good value rather than left to scale with core count,
    // which on a memory-constrained host oversubscribes real capacity.
    maxWorkers: 4,
  },
})
