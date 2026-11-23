import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
    applyDocumentSeo(document, resolvePageSeo("/")!)
    expect(document.title).toBe("OshiYobi – VTuber live status, schedule & new videos")
    expect(meta('meta[name="description"]')?.getAttribute("content")).toContain("OshiYobi")
    expect(meta('link[rel="canonical"]')?.getAttribute("href")).toBe("https://oshiyobi.web.app/")
    expect(meta('meta[property="og:url"]')?.getAttribute("content")).toBe("https://oshiyobi.web.app/")
    expect(meta('meta[name="robots"]')).toBeNull()
  })

  it("updates the tags in place, never duplicating them, as the visitor moves between pages", () => {
    applyDocumentSeo(document, resolvePageSeo("/")!)
    applyDocumentSeo(document, resolvePageSeo("/schedule")!)
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1)
    expect(meta('link[rel="canonical"]')?.getAttribute("href")).toBe("https://oshiyobi.web.app/schedule")
    expect(document.title).toBe("Live schedule | OshiYobi")
  })

  it("adds noindex on settings and removes it again on an indexable page", () => {
    applyDocumentSeo(document, resolvePageSeo("/setting")!)
    expect(meta('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow")
    applyDocumentSeo(document, resolvePageSeo("/schedule")!)
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

  it.each(["/nonexistent-page", "/creator/aizawa-ema"])("leaves the document untouched on %s (not a page), so the 404 page keeps its noindex", (path) => {
    document.head.innerHTML = '<title>Page not found | OshiYobi</title><meta name="robots" content="noindex, nofollow">'
    render(<Probe path={path} />)
    expect(document.title).toBe("Page not found | OshiYobi")
    expect(meta('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow")
    expect(meta('link[rel="canonical"]')).toBeNull()
  })
})
