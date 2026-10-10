import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { renderMarkdown } from "./markdown"

function renderMd(markdown: string) {
  return render(<div data-testid="root">{renderMarkdown(markdown)}</div>)
}

const LF_DOC = "## Title\n\nFirst paragraph with **bold**.\n\n- one\n- two\n\n---\n\n1. a\n2. b\n"

describe("renderMarkdown line endings", () => {
  it("renders a CRLF document into real headings, paragraphs and lists (not one run-on paragraph)", () => {
    const { container } = renderMd(LF_DOC.replace(/\n/g, "\r\n"))
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeInTheDocument()
    expect(container.querySelectorAll("p")).toHaveLength(1)
    expect(container.querySelector("ul")?.querySelectorAll("li")).toHaveLength(2)
    expect(container.querySelector("ol")?.querySelectorAll("li")).toHaveLength(2)
    expect(container.querySelector("hr")).toBeInTheDocument()
    expect(container.textContent).not.toContain("##")
  })

  it("renders a bare-CR document the same way", () => {
    const { container } = renderMd(LF_DOC.replace(/\n/g, "\r"))
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeInTheDocument()
    expect(container.querySelector("ul")?.querySelectorAll("li")).toHaveLength(2)
  })

  it("produces identical markup for LF, CRLF and CR input", () => {
    const lf = renderMd(LF_DOC).container.innerHTML
    const crlf = renderMd(LF_DOC.replace(/\n/g, "\r\n")).container.innerHTML
    const cr = renderMd(LF_DOC.replace(/\n/g, "\r")).container.innerHTML
    expect(crlf).toBe(lf)
    expect(cr).toBe(lf)
  })

  it("still keeps raw HTML inert for CRLF input (no HTML rendering introduced)", () => {
    const { container } = renderMd("<script>alert(1)</script>\r\n\r\n<b>x</b>\r\n")
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
    expect(container.textContent).toContain("<script>alert(1)</script>")
  })
})
