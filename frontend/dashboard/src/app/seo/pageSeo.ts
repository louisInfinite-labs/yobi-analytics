import { BRANCH_LABELS, ORGANIZATION_LABELS } from "../../entities/creator/model/domain.ts"
import type { BranchKey, ChannelType, GroupKey, LifecycleStage, OrganizationKey } from "../../entities/creator/model/domain.ts"
import { creatorIdToSlug } from "../navigation/creatorSlugRule.ts"
import { SITEMAP_ORIGIN } from "./sitemap.ts"

/** Per-page SEO metadata and the static (pre-JavaScript) page body, shared by the build-time page generator (vite.config.ts's seo plugin) and the
 * running app (useDocumentSeo.ts keeps the tab title/canonical right after in-app navigation). Pure and dependency-light on purpose: the Vite
 * config loads it in a Node context, so it imports only types, label tables and the slug rule -- never the app's registry module. Every Creator fact
 * comes from the generated Creator Registry; nothing about a Creator is written by hand here. */

export type SeoPageKind = "home" | "schedule" | "about" | "settings" | "creator" | "notFound"

/** The registry fields the SEO pages use (a structural subset of the app's CanonicalCreator, declared here from domain.ts's types so the Vite config's
 * Node-context type check never has to load creatorMaster.ts). */
export interface SeoCreator {
  creatorId: string
  displayName: string
  avatarUrl: string | null
  organization: OrganizationKey
  branch: BranchKey
  groupKey: GroupKey[]
  channelType: ChannelType
  lifecycleStage: LifecycleStage
  displayOrder: number
  active: boolean
  youtubeChannelId: string
}

export interface PageSeo {
  kind: SeoPageKind
  /** The page's own path ("/", "/creator/aizawa-ema", ...); empty for the not-found page, which has no URL of its own. */
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
export const CREATOR_PATH_PREFIX = "/creator/"

const HOME_DESCRIPTION =
  "OshiYobi is a tracking platform for VTuber fans: livestreams, new videos and upcoming-stream schedules from Hololive and VSPO creators in one place, with live and new-video notifications."
const SCHEDULE_DESCRIPTION = "Upcoming and ongoing livestreams from the Hololive and VSPO creators OshiYobi tracks, laid out by day on one schedule."
const ABOUT_DESCRIPTION = "What OshiYobi is: a tracking platform for VTuber fans that gathers livestreams, new videos and upcoming-stream schedules in one place."

/** The placeholder groupKey the registry uses for "no generation/unit"; it is data, not a name to show. */
const NO_GROUP = "NO"

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

const CJK = /[぀-ヿ㐀-鿿ｦ-ﾟ]/

/** A creator name as HTML: escaped, and marked lang="ja" when it contains Japanese characters so a screen reader / the page's `lang="en"` does not
 * mispronounce it. */
function nameHtml(name: string): string {
  const escaped = escapeHtml(name)
  return CJK.test(name) ? `<span lang="ja">${escaped}</span>` : escaped
}

export function creatorSeoPath(creator: Pick<SeoCreator, "creatorId">): string {
  return `${CREATOR_PATH_PREFIX}${creatorIdToSlug(creator.creatorId)}`
}

/** The absolute canonical URL of a path on the official host. */
function canonicalFor(path: string): string {
  return `${SITEMAP_ORIGIN}${path}`
}

/** "Hololive JP member" / "VSPO group channel" / ...: how the registry classifies the channel, in words. Only the registry's own fields. */
function profileLabel(creator: SeoCreator): string {
  if (creator.channelType === "member") return `${BRANCH_LABELS[creator.branch]} member`
  return `${ORGANIZATION_LABELS[creator.organization]} ${creator.channelType === "group" ? "group" : "staff"} channel`
}

function groupLabel(creator: SeoCreator): string | null {
  const groups = creator.groupKey.filter((group) => group !== NO_GROUP)
  return groups.length > 0 ? groups.join(" / ") : null
}

/** The SEO metadata of one registry creator, worded from its lifecycle stage and channel type. */
function creatorSeo(creator: SeoCreator): PageSeo {
  const path = creatorSeoPath(creator)
  const name = creator.displayName
  const profile = profileLabel(creator)
  let title: string
  let description: string
  if (creator.lifecycleStage === "graduated") {
    title = `${name} (graduated) – Past videos & streams | ${SITE_NAME}`
    description = `Past videos and streams of ${name} (${profile}, graduated) on ${SITE_NAME}, a VTuber live status, schedule and new-video tracker.`
  } else {
    const stage = creator.lifecycleStage === "pre_debut" ? `${profile}, pre-debut` : profile
    title = `${name} – Live status, schedule & videos | ${SITE_NAME}`
    description = `${name} (${stage}) on ${SITE_NAME}: live status, upcoming streams and recent videos in one place, with live and new-video notifications.`
  }
  return { kind: "creator", path, title, description, canonicalUrl: canonicalFor(path), indexable: true, ogImage: creator.avatarUrl ?? DEFAULT_OG_IMAGE }
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

/** The SEO metadata of a path the site serves as a page, or null for any other path (an unknown route, an inactive/unknown creator slug). A trailing
 * slash is ignored, matching the router. */
export function resolvePageSeo(pathname: string, creators: readonly SeoCreator[]): PageSeo | null {
  const path = pathname === "/" ? "/" : pathname.replace(/\/+$/, "")
  if (path in FIXED_PAGES) return FIXED_PAGES[path as keyof typeof FIXED_PAGES]
  if (!path.startsWith(CREATOR_PATH_PREFIX)) return null
  const slug = path.slice(CREATOR_PATH_PREFIX.length)
  const creator = creators.find((candidate) => candidate.active && creatorIdToSlug(candidate.creatorId) === slug)
  return creator ? creatorSeo(creator) : null
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Static body: the indexable text and crawlable links a page carries in its raw HTML (what a non-rendering crawler, a link extractor and Google's
// first pass read). It sits inside #root and is visible until React mounts: React replaces #root's children on first render (createRoot().render,
// no hydration), so it is never shown twice and there is no hidden or SEO-only copy. What a renderer sees AFTER React runs is the app itself.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SITE_NAV = `<nav aria-label="${SITE_NAME}"><a href="/">${SITE_NAME} home</a> · <a href="/schedule">Live schedule</a> · <a href="/about">About</a></nav>`

/** The active creators in the registry's canonical display order. */
function byDisplayOrder(creators: readonly SeoCreator[]): SeoCreator[] {
  return [...creators].filter((creator) => creator.active).sort((a, b) => a.displayOrder - b.displayOrder || a.creatorId.localeCompare(b.creatorId))
}

/** A list of crawlable links to the given creators' pages. */
function creatorLinks(creators: readonly SeoCreator[]): string {
  const items = creators.map((creator) => `<li><a href="${creatorSeoPath(creator)}">${nameHtml(creator.displayName)}</a></li>`)
  return `<ul>${items.join("")}</ul>`
}

/** The static body's container, the marker the build and the tests look for. */
function wrap(inner: string): string {
  return `<main data-seo-static>${inner}</main>`
}

/** The home page's static body: the site intro and a link to every creator, grouped by branch. */
function homeBody(creators: readonly SeoCreator[]): string {
  const active = byDisplayOrder(creators)
  const sections = (["hololive", "vspo"] as const)
    .map((organization) => {
      const inOrg = active.filter((creator) => creator.organization === organization)
      const branches = (Object.keys(BRANCH_LABELS) as (keyof typeof BRANCH_LABELS)[]).filter((branch) => inOrg.some((creator) => creator.branch === branch))
      return branches
        .map((branch) => `<h3>${escapeHtml(BRANCH_LABELS[branch])}</h3>${creatorLinks(inOrg.filter((creator) => creator.branch === branch))}`)
        .join("")
    })
    .join("")
  return wrap(
    `<h1>${SITE_NAME} – ${SITE_TAGLINE}</h1><p>${escapeHtml(HOME_DESCRIPTION)}</p>${SITE_NAV}` +
      `<h2>Creators on ${SITE_NAME}</h2>${sections}`,
  )
}

/** A creator page's static body: the name, registry facts, a YouTube channel link and links to the other pages and branch peers. */
function creatorBody(creator: SeoCreator, creators: readonly SeoCreator[]): string {
  const name = nameHtml(creator.displayName)
  const profile = escapeHtml(profileLabel(creator))
  const facts = [
    `<li>Organization: ${escapeHtml(ORGANIZATION_LABELS[creator.organization])}</li>`,
    `<li>Branch: ${escapeHtml(BRANCH_LABELS[creator.branch])}</li>`,
  ]
  const group = groupLabel(creator)
  if (group) facts.push(`<li>Generation / unit: ${nameHtml(group)}</li>`)
  if (creator.lifecycleStage === "pre_debut") facts.push("<li>Status: pre-debut</li>")
  if (creator.lifecycleStage === "graduated") facts.push("<li>Status: graduated</li>")
  const channel = `<a href="https://www.youtube.com/channel/${encodeURIComponent(creator.youtubeChannelId)}" rel="noopener noreferrer">YouTube channel</a>`

  const intro =
    creator.lifecycleStage === "graduated"
      ? `${name} (${profile}) has graduated. ${SITE_NAME} keeps this page for the past videos and streams it already tracked, but no longer collects new content.`
      : `${name} is a ${profile}${creator.lifecycleStage === "pre_debut" ? " (pre-debut)" : ""}. On ${SITE_NAME} you can see ${name}’s live status, upcoming streams and recent videos in one place, and turn on live and new-video notifications.`

  const peers = byDisplayOrder(creators).filter((other) => other.branch === creator.branch && other.creatorId !== creator.creatorId)
  const peersSection = peers.length > 0 ? `<h2>More ${escapeHtml(BRANCH_LABELS[creator.branch])} on ${SITE_NAME}</h2>${creatorLinks(peers)}` : ""
  return wrap(`<h1>${name}</h1><p>${intro}</p><ul>${facts.join("")}</ul><p>${channel}</p>${SITE_NAV}${peersSection}`)
}

/** The static body of a page that is only a heading, one paragraph and the site links. */
function simpleBody(heading: string, paragraph: string): string {
  return wrap(`<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(paragraph)}</p>${SITE_NAV}`)
}

/** The static body for a page resolved by resolvePageSeo (or the not-found page). */
export function buildStaticBody(seo: PageSeo, creators: readonly SeoCreator[]): string {
  switch (seo.kind) {
    case "home":
      return homeBody(creators)
    case "creator": {
      const creator = creators.find((candidate) => creatorSeoPath(candidate) === seo.path)
      if (!creator) throw new Error(`seo: no registry creator for ${seo.path}`)
      return creatorBody(creator, creators)
    }
    case "schedule":
      return simpleBody("Live schedule", SCHEDULE_DESCRIPTION)
    case "about":
      return simpleBody(`About ${SITE_NAME}`, ABOUT_DESCRIPTION)
    case "settings":
      return simpleBody("Settings", seo.description)
    case "notFound":
      return simpleBody("Page not found", "This page does not exist. Use the links below to find a creator, the live schedule or the home page.")
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
export function renderSeoPage(shell: string, seo: PageSeo, creators: readonly SeoCreator[]): string {
  if (!TITLE_TAG.test(shell) || !shell.includes(ROOT_TAG) || !shell.includes("</head>")) {
    throw new Error("seo: the built index.html lacks <title>, </head> or an empty <div id=\"root\"></div>")
  }
  return shell
    .replace(TITLE_TAG, () => `<title>${escapeHtml(seo.title)}</title>`)
    .replace("</head>", () => `  ${headTags(seo)}\n  </head>`)
    .replace(ROOT_TAG, () => `<div id="root">${buildStaticBody(seo, creators)}</div>`)
}

/** The shell paths a built page is written to: "/" is index.html itself; every other path is "<path>/index.html" (the directory index Firebase
 * Hosting serves at the extensionless URL). */
export function pageFileName(path: string): string {
  return path === "/" ? "index.html" : `${path.replace(/^\//, "")}/index.html`
}
