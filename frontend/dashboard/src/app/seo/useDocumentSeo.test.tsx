import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getCreators } from "../../entities/creator/data/creatorRegistry"
import { NOT_FOUND_SEO, resolvePageSeo } from "./pageSeo"
import { applyDocumentSeo, useDocumentSeo } from "./useDocumentSeo"

function Probe({ path }: { path: string }) {
  useDocumentSeo(path)
  return null
}

const meta = (selector: string) => document.head.querySelector(selector)

beforeEach(() => {
  document.head.innerHTML = "<title>OshiYobi</title>"
})
afterEach(() => {
  document.head.innerHTML = ""
})

describe("applyDocumentSeo", () => {
  it("creates the title, description, canonical and Open Graph tags on a bare shell", () => {
    applyDocumentSeo(document, resolvePageSeo("/creator/kurumi-noa", getCreators())!)
    expect(document.title).toBe("胡桃のあ – Live status, schedule & videos | OshiYobi")
    expect(meta('meta[name="description"]')?.getAttribute("content")).toContain("胡桃のあ")
    expect(meta('link[rel="canonical"]')?.getAttribute("href")).toBe("https://oshiyobi.web.app/creator/kurumi-noa")
    expect(meta('meta[property="og:url"]')?.getAttribute("content")).toBe("https://oshiyobi.web.app/creator/kurumi-noa")
    expect(meta('meta[name="robots"]')).toBeNull()
  })

  it("updates the tags in place, never duplicating them, as the visitor moves between pages", () => {
    applyDocumentSeo(document, resolvePageSeo("/creator/kurumi-noa", getCreators())!)
    applyDocumentSeo(document, resolvePageSeo("/creator/usada-pekora", getCreators())!)
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1)
    expect(meta('link[rel="canonical"]')?.getAttribute("href")).toBe("https://oshiyobi.web.app/creator/usada-pekora")
    expect(document.title).toContain("兎田ぺこら")
  })

  it("adds noindex on settings and removes it again on an indexable page", () => {
    applyDocumentSeo(document, resolvePageSeo("/setting", getCreators())!)
    expect(meta('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow")
    applyDocumentSeo(document, resolvePageSeo("/schedule", getCreators())!)
    expect(meta('meta[name="robots"]')).toBeNull()
  })

  it("leaves a 404 page without a canonical", () => {
    applyDocumentSeo(document, NOT_FOUND_SEO)
    expect(meta('link[rel="canonical"]')).toBeNull()
    expect(meta('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow")
  })
})

describe("useDocumentSeo", () => {
  it("applies the current path's metadata and follows path changes", () => {
    const view = render(<Probe path="/schedule" />)
    expect(document.title).toBe("Live schedule | OshiYobi")
    view.rerender(<Probe path="/about" />)
    expect(document.title).toBe("About OshiYobi")
    expect(meta('link[rel="canonical"]')?.getAttribute("href")).toBe("https://oshiyobi.web.app/about")
  })

  it("leaves the document untouched on a path that is not a page, so a 404 page keeps its noindex", () => {
    document.head.innerHTML = '<title>Page not found | OshiYobi</title><meta name="robots" content="noindex, nofollow">'
    render(<Probe path="/nonexistent-page" />)
    expect(document.title).toBe("Page not found | OshiYobi")
    expect(meta('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow")
    expect(meta('link[rel="canonical"]')).toBeNull()
  })
})
