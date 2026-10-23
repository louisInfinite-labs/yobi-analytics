import { useEffect } from "react"
import { getCreators } from "../../entities/creator/data/creatorRegistry"
import { resolvePageSeo, type PageSeo } from "./pageSeo"

/** The head element matching the selector, created and appended when the shell does not have it yet. */
function upsertHead(document: Document, selector: string, create: () => HTMLElement): HTMLElement {
  const existing = document.head.querySelector<HTMLElement>(selector)
  if (existing) return existing
  const element = create()
  document.head.appendChild(element)
  return element
}

/** Sets the content of a <meta name|property> tag, creating it when missing. */
function setMeta(document: Document, attribute: "name" | "property", key: string, content: string): void {
  const element = upsertHead(document, `meta[${attribute}="${key}"]`, () => {
    const meta = document.createElement("meta")
    meta.setAttribute(attribute, key)
    return meta
  })
  element.setAttribute("content", content)
}

/** Writes a page's metadata into the live document: tab title, description, canonical, robots and the Open Graph tags. The build already put the
 * right values in each page's own HTML; this keeps them right after an in-app (pushState) navigation, where no new HTML is fetched, and repairs a
 * shell served from an older cache. */
export function applyDocumentSeo(document: Document, seo: PageSeo): void {
  document.title = seo.title
  setMeta(document, "name", "description", seo.description)
  setMeta(document, "property", "og:title", seo.title)
  setMeta(document, "property", "og:description", seo.description)
  setMeta(document, "property", "og:image", seo.ogImage)
  if (seo.canonicalUrl) {
    const link = upsertHead(document, 'link[rel="canonical"]', () => {
      const created = document.createElement("link")
      created.setAttribute("rel", "canonical")
      return created
    })
    link.setAttribute("href", seo.canonicalUrl)
    setMeta(document, "property", "og:url", seo.canonicalUrl)
  }
  const robots = document.head.querySelector<HTMLElement>('meta[name="robots"]')
  if (seo.indexable) robots?.remove()
  else setMeta(document, "name", "robots", "noindex, nofollow")
}

/** Keeps the document's SEO metadata in step with the current path. A path that is not a known page (an unknown route, which the host answers with
 * HTTP 404 and a noindex page) is left alone, so a 404 page never loses its noindex. */
export function useDocumentSeo(pathname: string): void {
  useEffect(() => {
    const seo = resolvePageSeo(pathname, getCreators())
    if (seo) applyDocumentSeo(document, seo)
  }, [pathname])
}
