import { SITEMAP_ORIGIN } from "./sitemap.ts"

/** Per-page SEO metadata and the static (pre-JavaScript) page body, shared by the build-time page generator (vite.config.ts's seo plugin) and the
 * running app (useDocumentSeo.ts keeps the tab title/canonical right after in-app navigation). Pure and dependency-free on purpose: the Vite
 * config loads it in a Node context. The site's pages are fixed: "/", "/schedule", "/about" (indexable) and "/setting" (noindex). Which creator
 * Home shows is in-app state, so there is no per-creator page, metadata or URL. */

export type SeoPageKind = "home" | "schedule" | "about" | "settings" | "notFound"

export interface PageSeo {
  kind: SeoPageKind
  /** The page's own path ("/", "/schedule", ...); empty for the not-found page, which has no URL of its own. */
  path: string
  title: string
  description: string
  /** Absolute canonical URL (always on the official host, so the firebaseapp.com copy of the site points back at it); null on not-found. */
  canonicalUrl: string | null
  indexable: boolean
  ogImage: string
}

export const SITE_NAME = "OshiYobi"
export const SITE_TAGLINE = "推しが呼んでる。"
export const DEFAULT_OG_IMAGE = `${SITEMAP_ORIGIN}/icons/icon-512.png`

const HOME_DESCRIPTION =
  "OshiYobi is a tracking platform for VTuber fans: livestreams, new videos and upcoming-stream schedules from Hololive and VSPO creators in one place, with live and new-video notifications."
const SCHEDULE_DESCRIPTION = "Upcoming and ongoing livestreams from the Hololive and VSPO creators OshiYobi tracks, laid out by day on one schedule."
/** The About page's one line, in its meta description and its static body. It is the same sentence as the first line of the English About content
 * (src/content/about/en/about.md), which the running page renders, so the raw HTML and the rendered page state the same facts: the two supported
 * groups, Hololive and VSPO!. pageSeo.test.ts keeps the two in step. */
const ABOUT_DESCRIPTION = "OshiYobi (推し呼び) is a website for checking livestream information from Hololive and VSPO! VTubers."

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

/** The absolute canonical URL of a path on the official host. */
function canonicalFor(path: string): string {
  return `${SITEMAP_ORIGIN}${path}`
}

const FIXED_PAGES: Record<"/" | "/schedule" | "/about" | "/setting", PageSeo> = {
  "/": {
    kind: "home",
    path: "/",
    title: `${SITE_NAME} – VTuber live status, schedule & new videos`,
    description: HOME_DESCRIPTION,
    canonicalUrl: canonicalFor("/"),
    indexable: true,
    ogImage: DEFAULT_OG_IMAGE,
  },
  "/schedule": {
    kind: "schedule",
    path: "/schedule",
    title: `Live schedule | ${SITE_NAME}`,
    description: SCHEDULE_DESCRIPTION,
    canonicalUrl: canonicalFor("/schedule"),
    indexable: true,
    ogImage: DEFAULT_OG_IMAGE,
  },
  "/about": {
    kind: "about",
    path: "/about",
    title: `About ${SITE_NAME}`,
    description: ABOUT_DESCRIPTION,
    canonicalUrl: canonicalFor("/about"),
    indexable: true,
    ogImage: DEFAULT_OG_IMAGE,
  },
  // Per-user settings: reachable and crawlable (so a crawler sees the noindex), but never indexed.
  "/setting": {
    kind: "settings",
    path: "/setting",
    title: `Settings | ${SITE_NAME}`,
    description: "OshiYobi notification and Oshi settings, stored on your own device.",
    canonicalUrl: canonicalFor("/setting"),
    indexable: false,
    ogImage: DEFAULT_OG_IMAGE,
  },
}

export const NOT_FOUND_SEO: PageSeo = {
  kind: "notFound",
  path: "",
  title: `Page not found | ${SITE_NAME}`,
  description: "This OshiYobi page does not exist.",
  canonicalUrl: null,
  indexable: false,
  ogImage: DEFAULT_OG_IMAGE,
}

/** The SEO metadata of a path the site serves as a page, or null for any other path (an unknown route -- including any /creator/... URL, which
 * the host either redirects to the root Home (a retired creator page, firebase.json) or answers with HTTP 404 and the noindex not-found page).
 * A trailing slash is ignored. */
export function resolvePageSeo(pathname: string): PageSeo | null {
  const path = pathname === "/" ? "/" : pathname.replace(/\/+$/, "")
  return path in FIXED_PAGES ? FIXED_PAGES[path as keyof typeof FIXED_PAGES] : null
}

/** Every page the build writes, in order: the sitemap's indexable pages, then the noindex settings page. */
export const SEO_PAGE_PATHS: readonly string[] = ["/", "/schedule", "/about", "/setting"]

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Static body: the indexable text and crawlable links a page carries in its raw HTML (what a non-rendering crawler, a link extractor and Google's
// first pass read). It sits inside #root and is visible until React mounts: React replaces #root's children on first render (createRoot().render,
// no hydration), so it is never shown twice and there is no hidden or SEO-only copy. What a renderer sees AFTER React runs is the app itself.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SITE_NAV = `<nav aria-label="${SITE_NAME}"><a href="/">${SITE_NAME} home</a> · <a href="/schedule">Live schedule</a> · <a href="/about">About</a></nav>`

/** The static body's container, the marker the build and the tests look for. */
function wrap(inner: string): string {
  return `<main data-seo-static>${inner}</main>`
}

/** What the home page offers, in its static body: the same features the app's own "About OshiYobi" section describes. Plain text, no data. */
const HOME_FEATURES = [
  "Live Status: see who is live or about to go live, and switch the home screen to any creator.",
  "Live schedule: upcoming and ongoing streams, laid out by day.",
  "Video list: recent videos and streams by topic, with a count of the new ones you have not watched yet.",
  "Settings: choose your Oshi and turn on live and new-video notifications.",
]

/** The home page's static body: the site name, what it is, what it offers and the site links. */
function homeBody(): string {
  const features = HOME_FEATURES.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")
  return wrap(`<h1>${SITE_NAME} – ${SITE_TAGLINE}</h1><p>${escapeHtml(HOME_DESCRIPTION)}</p><ul>${features}</ul>${SITE_NAV}`)
}

/** The static body of a page that is only a heading, one paragraph and the site links. */
function simpleBody(heading: string, paragraph: string): string {
  return wrap(`<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(paragraph)}</p>${SITE_NAV}`)
}

/** The static body for a page resolved by resolvePageSeo (or the not-found page). */
export function buildStaticBody(seo: PageSeo): string {
  switch (seo.kind) {
    case "home":
      return homeBody()
    case "schedule":
      return simpleBody("Live schedule", SCHEDULE_DESCRIPTION)
    case "about":
      return simpleBody(`About ${SITE_NAME}`, ABOUT_DESCRIPTION)
    case "settings":
      return simpleBody("Settings", seo.description)
    case "notFound":
      return simpleBody("Page not found", "This page does not exist. Use the links below to go to the home page, the live schedule or About.")
  }
}

/** The JSON-LD for the home page: it names the site (what Google's site-name feature reads). Not added to any other page: nothing else here has a
 * structured-data type whose required facts OshiYobi actually holds. */
export function buildHomeJsonLd(): string {
  const data = { "@context": "https://schema.org", "@type": "WebSite", name: SITE_NAME, url: `${SITEMAP_ORIGIN}/` }
  return JSON.stringify(data).replace(/</g, "\\u003c")
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// HTML shell rewriting (build time)
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The <head> tags a page adds to the shell: description, robots (noindex pages only), canonical, Open Graph, and JSON-LD on the home page. */
function headTags(seo: PageSeo): string {
  const tags = [`<meta name="description" content="${escapeHtml(seo.description)}" />`]
  if (!seo.indexable) tags.push('<meta name="robots" content="noindex, nofollow" />')
  if (seo.canonicalUrl) tags.push(`<link rel="canonical" href="${escapeHtml(seo.canonicalUrl)}" />`)
  tags.push(
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${escapeHtml(seo.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(seo.description)}" />`,
    `<meta property="og:image" content="${escapeHtml(seo.ogImage)}" />`,
  )
  if (seo.canonicalUrl) tags.push(`<meta property="og:url" content="${escapeHtml(seo.canonicalUrl)}" />`)
  tags.push('<meta name="twitter:card" content="summary" />')
  if (seo.kind === "home") tags.push(`<script type="application/ld+json">${buildHomeJsonLd()}</script>`)
  return tags.join("\n    ")
}

const TITLE_TAG = /<title>[^<]*<\/title>/
const ROOT_TAG = '<div id="root"></div>'

/** Turns the built dist/index.html shell into one page's HTML: its own <title>, description, canonical, robots and Open Graph tags in <head>, and its
 * static body inside #root. Throws (failing the build) if the shell no longer has the <title> or empty #root this relies on, rather
 * than emitting a page without its SEO. */
export function renderSeoPage(shell: string, seo: PageSeo): string {
  if (!TITLE_TAG.test(shell) || !shell.includes(ROOT_TAG) || !shell.includes("</head>")) {
    throw new Error("seo: the built index.html lacks <title>, </head> or an empty <div id=\"root\"></div>")
  }
  return shell
    .replace(TITLE_TAG, () => `<title>${escapeHtml(seo.title)}</title>`)
    .replace("</head>", () => `  ${headTags(seo)}\n  </head>`)
    .replace(ROOT_TAG, () => `<div id="root">${buildStaticBody(seo)}</div>`)
}

/** The shell paths a built page is written to: "/" is index.html itself; every other path is "<path>/index.html" (the directory index Firebase
 * Hosting serves at the extensionless URL). */
export function pageFileName(path: string): string {
  return path === "/" ? "index.html" : `${path.replace(/^\//, "")}/index.html`
}
