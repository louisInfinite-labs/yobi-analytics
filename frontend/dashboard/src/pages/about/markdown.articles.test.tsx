/// <reference types="node" />
import { readFileSync } from "node:fs"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { renderMarkdown } from "./markdown"

// The approved source documents live outside the Vite root, so they are read from disk rather than imported.
// Vitest runs with the dashboard package as its working directory (frontend/dashboard).
const ROOT = process.cwd()
const aboutCss = readFileSync(`${ROOT}/src/pages/about/styles/about.css`, "utf-8")
const zhTw = (file: string) => readFileSync(`${ROOT}/../../src/content/about/zh-TW/${file}`, "utf-8")
const aboutMd = zhTw("about.md")
const dataSourcesMd = zhTw("data-sources.md")
const privacyMd = zhTw("privacy.md")
const termsMd = zhTw("terms.md")
const acknowledgementsMd = zhTw("acknowledgements.md")

function renderMd(markdown: string) {
  return render(<div>{renderMarkdown(markdown)}</div>).container
}

/** The tag sequence of the rendered article's direct children, e.g. ["H2", "P", "H3", "P", "UL"]. */
function shape(container: HTMLElement): string[] {
  return Array.from((container.firstElementChild as HTMLElement).children).map((element) => element.tagName)
}

describe("real CRLF payload (what production once served)", () => {
  // Real carriage returns, exactly as a Windows-published object contained them.
  const CRLF_DOC = "## heading\r\n\r\nparagraph\r\n\r\n### heading\r\n\r\nparagraph\r\n\r\n- list item\r\n- list item\r\n"

  it("contains real CR characters (so this test cannot pass by accident on LF text)", () => {
    expect(CRLF_DOC.includes("\r\n")).toBe(true)
    expect(CRLF_DOC.split("\r\n").length).toBeGreaterThan(5)
  })

  it("renders H2, a separate paragraph, H3, a separate paragraph, then a UL with two LI", () => {
    const container = renderMd(CRLF_DOC)

    expect(shape(container)).toEqual(["H2", "P", "H3", "P", "UL"])
    expect(container.querySelectorAll("ul > li")).toHaveLength(2)
  })

  it("shows zero literal ## or ### markers in the visible text", () => {
    const container = renderMd(CRLF_DOC)

    expect(container.textContent).not.toContain("#")
  })

  it("keeps two adjacent paragraphs as two distinct <p> elements", () => {
    const container = renderMd("paragraph A\r\n\r\nparagraph B\r\n")

    expect(Array.from(container.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["paragraph A", "paragraph B"])
  })
})

describe("article constructs", () => {
  it("renders a standalone bold line as a paragraph containing <strong>, never a heading", () => {
    const container = renderMd("**推しが呼んでる。**\n\nnext paragraph")

    expect(shape(container)).toEqual(["P", "P"])
    expect(container.querySelector("p > strong")?.textContent).toBe("推しが呼んでる。")
    expect(container.querySelector("h1, h2, h3")).toBeNull()
  })

  it("renders an https link as a clickable external anchor with no raw Markdown syntax", () => {
    const container = renderMd("[Google Privacy Policy](https://policies.google.com/privacy)")

    const anchor = container.querySelector("a") as HTMLAnchorElement
    expect(anchor.getAttribute("href")).toBe("https://policies.google.com/privacy")
    expect(anchor.getAttribute("target")).toBe("_blank")
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.textContent).toBe("Google Privacy Policy")
  })

  it("does not make non-https, javascript: or data: Markdown links clickable", () => {
    const container = renderMd("[a](http://example.com) [b](javascript:alert(1)) [c](data:text/html,x) [d](//example.com)")

    expect(container.querySelector("a")).toBeNull()
  })

  it("keeps a document that opens with an intro paragraph before its first H2 (the Acknowledgements shape)", () => {
    const container = renderMd("intro\n\n## Holodex\n\nbody\n")

    expect(shape(container)).toEqual(["P", "H2", "P"])
  })
})

describe("the five approved zh-TW source documents render with their Markdown hierarchy", () => {
  const SOURCES: Record<string, string> = {
    about: aboutMd,
    "data-sources": dataSourcesMd,
    privacy: privacyMd,
    terms: termsMd,
    acknowledgements: acknowledgementsMd,
  }

  /** Counts derived from the raw source, so a content edit keeps this test honest. */
  function expected(source: string) {
    const lines = source.replace(/\r\n?/g, "\n").split("\n")
    return {
      h2: lines.filter((line) => /^## /.test(line)).length,
      h3: lines.filter((line) => /^### /.test(line)).length,
      listItems: lines.filter((line) => /^- /.test(line)).length,
      links: (source.match(/\]\(https:\/\//g) ?? []).length,
    }
  }

  for (const [name, source] of Object.entries(SOURCES)) {
    for (const [variant, text] of [
      ["as checked out", source],
      ["as LF", source.replace(/\r\n?/g, "\n")],
      ["as CRLF", source.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")],
    ] as const) {
      it(`${name} (${variant}): headings, lists and links all render, with no literal Markdown`, () => {
        const container = renderMd(text)
        const want = expected(source)

        expect(container.querySelectorAll("h2")).toHaveLength(want.h2)
        expect(container.querySelectorAll("h3")).toHaveLength(want.h3)
        expect(container.querySelectorAll("li")).toHaveLength(want.listItems)
        expect(container.querySelectorAll("a")).toHaveLength(want.links)
        const visible = container.textContent ?? ""
        expect(visible).not.toContain("#")
        expect(visible).not.toContain("**")
        expect(visible).not.toContain("](")
      })
    }
  }

  it("acknowledgements opens with a normal paragraph, then H2 sections, and ends with a bold paragraph", () => {
    const container = renderMd(acknowledgementsMd)
    const tags = shape(container)

    expect(tags[0]).toBe("P")
    expect(tags.filter((tag) => tag === "H2")).toHaveLength(3)
    expect(tags.at(-1)).toBe("P")
    expect(container.querySelector("p:last-child > strong")).not.toBeNull()
  })

  it("never turns a standalone bold sentence into a heading", () => {
    for (const source of Object.values(SOURCES)) {
      const container = renderMd(source)
      for (const heading of Array.from(container.querySelectorAll("h1, h2, h3"))) {
        expect(heading.querySelector("strong")).toBeNull()
      }
    }
  })
})

describe("about.css typography values", () => {
  /** The declarations of the first rule whose selector list is exactly `selector`. */
  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(aboutCss.replace(/\r\n/g, "\n"))
    expect(match, `no rule for ${selector}`).not.toBeNull()
    return match![1]
  }

  it("keeps the article at 720px, left aligned (not centered)", () => {
    expect(rule(".about-content")).toContain("max-width: 720px")
    expect(rule(".about-content")).not.toMatch(/margin:\s*0 auto|margin-inline:\s*auto/)
  })

  it("the Markdown H1 rule does not override the page title, which keeps the Settings title style", () => {
    expect(aboutCss).toContain(".about-content > h1 {")
    expect(aboutCss).not.toMatch(/\.about-content h1\s*\{/)
  })

  it("H2 is 20px / 700 / 1.4 with a 32px gap above and 12px below", () => {
    const h2 = rule(".about-content h2")
    expect(h2).toContain("font-size: 20px")
    expect(h2).toContain("font-weight: 700")
    expect(h2).toContain("line-height: 1.4")
    expect(h2).toContain("margin: var(--space-6) 0 var(--space-3)")
  })

  it("only an H2 directly after the page header drops its top gap (an intro paragraph keeps the section gap)", () => {
    expect(aboutCss).toContain(".about-content > .settings-page-header + h2")
    expect(aboutCss).not.toContain("h2:first-of-type")
  })

  it("H3 is 16px / 700 / 1.45 with 24px above and 8px below", () => {
    const h3 = rule(".about-content h3")
    expect(h3).toContain("font-size: 16px")
    expect(h3).toContain("font-weight: 700")
    expect(h3).toContain("line-height: 1.45")
    expect(h3).toContain("margin: var(--space-5) 0 var(--space-2)")
  })

  it("paragraphs are 14px / 1.75 with 12px after", () => {
    const p = rule(".about-content p")
    expect(p).toContain("font-size: 14px")
    expect(p).toContain("line-height: 1.75")
    expect(p).toContain("margin: 0 0 var(--space-3)")
  })

  it("lists show markers (the global reset removes them), with 12px below and 24px indent; items are 14px / 1.7 / 8px", () => {
    expect(aboutCss).toMatch(/\.about-content ul\s*\{\s*list-style:\s*disc/)
    expect(aboutCss).toMatch(/\.about-content ol\s*\{\s*list-style:\s*decimal/)
    const list = aboutCss.replace(/\r\n/g, "\n").match(/\.about-content ul,\n\.about-content ol\s*\{([^}]*)\}/)![1]
    expect(list).toContain("margin: 0 0 var(--space-3)")
    expect(list).toContain("padding-left: var(--space-5)")
    const li = rule(".about-content li")
    expect(li).toContain("font-size: 14px")
    expect(li).toContain("line-height: 1.7")
    expect(li).toContain("margin-bottom: var(--space-2)")
  })

  it("links use the theme color with an underline affordance; strong is bright and bold", () => {
    const a = rule(".about-content a")
    expect(a).toContain("color: var(--theme-primary)")
    expect(a).toContain("text-decoration: underline")
    const strong = rule(".about-content strong")
    expect(strong).toContain("color: #f3eff5")
    expect(strong).toContain("font-weight: 700")
  })
})
