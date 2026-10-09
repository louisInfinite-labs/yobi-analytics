import { apiRequest } from "../../../shared/api/apiClient"

/** One page's content is raw Markdown text (src/api/about_content_api.py) --
 * the backend owns the canonical copy, page/section order, headings,
 * emphasis, and lists entirely through standard Markdown syntax; this
 * frontend owns a small, safe Markdown renderer (markdown.tsx) that turns
 * it into React elements. Never raw HTML, never `dangerouslySetInnerHTML` --
 * an unsupported/unsafe construct (e.g. a non-"https://" link) renders as
 * plain text instead of being interpreted. */
export interface AboutPage {
  id: string
  title: string
  markdown: string
}

export interface AboutContent {
  schemaVersion: number
  contentVersion: string
  locales: Record<string, { pages: AboutPage[] }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sanitizePage(raw: unknown): AboutPage | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.markdown !== "string" || !raw.markdown) {
    return null
  }
  return { id: raw.id, title: raw.title, markdown: raw.markdown }
}

/** The only /about-content envelope version this build knows how to render.
 * A response claiming any other version is treated as a failed fetch so it
 * can never enter the last-known-good cache. */
const SUPPORTED_SCHEMA_VERSION = 1

/** Defensive runtime validation of a live network response. A malformed
 * individual page is dropped rather than rejecting the whole payload;
 * `null` is returned only when the payload is fundamentally unusable --
 * unsupported/missing schemaVersion, or no locale ends up with any usable
 * page at all -- which the caller treats as a failed fetch (falls back to
 * cached content, see aboutContentStore.ts). */
export function validateAboutContent(raw: unknown): AboutContent | null {
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return null
  if (typeof raw.contentVersion !== "string" || !raw.contentVersion) return null
  if (!isRecord(raw.locales)) return null

  const locales: Record<string, { pages: AboutPage[] }> = {}
  for (const [locale, value] of Object.entries(raw.locales)) {
    const pagesRaw = isRecord(value) ? value.pages : undefined
    if (!Array.isArray(pagesRaw)) continue
    const pages = pagesRaw.map(sanitizePage).filter((page): page is AboutPage => page !== null)
    if (pages.length > 0) locales[locale] = { pages }
  }
  if (Object.keys(locales).length === 0) return null

  return { schemaVersion: raw.schemaVersion, contentVersion: raw.contentVersion, locales }
}

/** Calls the backend's own GET /about-content (src/api/about_content_api.py)
 * and validates the response -- throws if the payload is fundamentally
 * unusable, so the caller (aboutContentStore.ts) can fall back to its
 * last-known-good cached content instead of rendering something broken. */
export async function fetchAboutContent(): Promise<AboutContent> {
  const raw = await apiRequest<unknown>("/about-content")
  const validated = validateAboutContent(raw)
  if (!validated) throw new Error("Received a malformed About content response")
  return validated
}
