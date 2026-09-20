import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ComparisonOrderBadge } from "./ComparisonOrderBadge"

describe("ComparisonOrderBadge", () => {
  it("MT-10 AC2: renders the numeric order for A, B, and C in click order", () => {
    render(
      <>
        <ComparisonOrderBadge order={1} />
        <ComparisonOrderBadge order={2} />
        <ComparisonOrderBadge order={3} />
      </>,
    )

    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("MT-10 AC3: exposes an accessible label carrying the numeric comparison order", () => {
    render(<ComparisonOrderBadge order={2} />)
    expect(screen.getByLabelText("Comparison order 2")).toBeInTheDocument()
  })

  it("renders a plain rendered numeral rather than a Unicode circled-number glyph, so large orders remain legible", () => {
    render(<ComparisonOrderBadge order={12} />)
    expect(screen.getByText("12")).toBeInTheDocument()
    expect(screen.getByLabelText("Comparison order 12")).toBeInTheDocument()
  })

  it("carries the anchor class for top-right positioning against a relatively-positioned avatar wrapper", () => {
    render(<ComparisonOrderBadge order={1} />)
    expect(screen.getByText("1")).toHaveClass("comparison-order-badge")
  })
})
