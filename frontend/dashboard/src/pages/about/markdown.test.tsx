import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { renderMarkdown } from "./markdown"

function renderMd(markdown: string) {
  return render(<div data-testid="root">{renderMarkdown(markdown)}</div>)
}

describe("renderMarkdown", () => {
  it("renders ## and ### as h2/h3, and # as h1", () => {
    renderMd("# One\n\n## Two\n\n### Three")
    expect(screen.getByRole("heading", { level: 1, name: "One" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "Two" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 3, name: "Three" })).toBeInTheDocument()
  })

  it("renders a plain block as a paragraph", () => {
    const { container } = renderMd("Hello world.")
    expect(container.querySelector("p")?.textContent).toBe("Hello world.")
  })

  it("renders **bold** as strong", () => {
    renderMd("This is **important** text.")
    expect(screen.getByText("important").tagName).toBe("STRONG")
  })

  it("renders a bullet list as ul/li", () => {
    const { container } = renderMd("- one\n- two\n- three")
    const ul = container.querySelector("ul")
    expect(ul).toBeInTheDocument()
    expect(ul?.querySelectorAll("li")).toHaveLength(3)
    expect(container.querySelector("ol")).toBeNull()
  })

  it("renders an ordered list as ol/li", () => {
    const { container } = renderMd("1. first\n2. second")
    const ol = container.querySelector("ol")
    expect(ol).toBeInTheDocument()
    expect(ol?.querySelectorAll("li")).toHaveLength(2)
    expect(container.querySelector("ul")).toBeNull()
  })

  it("switching a backend list from bullet to ordered changes the rendered tag with zero renderer changes", () => {
    const bullet = renderMd("- same item").container
    expect(bullet.querySelector("ul")).toBeInTheDocument()
    const ordered = renderMd("1. same item").container
    expect(ordered.querySelector("ol")).toBeInTheDocument()
  })

  it("renders --- as a horizontal rule", () => {
    const { container } = renderMd("above\n\n---\n\nbelow")
    expect(container.querySelector("hr")).toBeInTheDocument()
  })

  it("renders a https:// link as a real anchor to the exact URL, label unchanged", () => {
    renderMd("See [Google Privacy Policy](https://policies.google.com/privacy) for details.")
    const link = screen.getByRole("link", { name: "Google Privacy Policy" })
    expect(link).toHaveAttribute("href", "https://policies.google.com/privacy")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("a non-https link scheme is never turned into a clickable link", () => {
    const { container } = renderMd("[click me](javascript:alert(1))")
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("[click me](javascript:alert(1))")
  })

  it("an http:// (non-https) link is also never turned into a clickable link", () => {
    const { container } = renderMd("[insecure](http://example.com)")
    expect(container.querySelector("a")).toBeNull()
  })

  it("a bare bracketed placeholder with no following (url) stays literal text, not a link", () => {
    const { container } = renderMd("**[聯絡方式]**")
    expect(container.querySelector("a")).toBeNull()
    expect(screen.getByText("[聯絡方式]").tagName).toBe("STRONG")
  })

  it("an HTML-looking string in content is never parsed as markup", () => {
    const { container } = renderMd("<script>alert(1)</script> and <b>bold</b>")
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
    expect(container.textContent).toContain("<script>alert(1)</script>")
  })

  it("malformed/unterminated syntax does not crash and falls back to literal text", () => {
    expect(() => renderMd("**unterminated bold and a stray ] and (")).not.toThrow()
  })

  it("an unsupported construct (a table-like line) falls back to a paragraph", () => {
    const { container } = renderMd("| a | b |\n| - | - |")
    expect(container.querySelector("table")).toBeNull()
    expect(container.querySelector("p")).toBeInTheDocument()
  })

  it("renders multiple blocks in document order", () => {
    const { container } = renderMd("## Heading\n\nFirst paragraph.\n\n- item one\n- item two\n\nLast paragraph.")
    const children = Array.from(container.querySelector('[data-testid="root"]')!.children)
    expect(children.map((el) => el.tagName)).toEqual(["H2", "P", "UL", "P"])
  })
})
