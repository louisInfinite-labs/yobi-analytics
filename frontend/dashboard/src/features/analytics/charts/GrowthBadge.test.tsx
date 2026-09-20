import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { GrowthBadge } from "./GrowthBadge"

describe("GrowthBadge", () => {
  it("renders a signed positive percent", () => {
    render(<GrowthBadge percent={24.6} />)
    expect(screen.getByText("+24.6%")).toBeInTheDocument()
  })

  it("renders a signed negative percent, not relying on color alone", () => {
    render(<GrowthBadge percent={-1.3} />)
    expect(screen.getByText("-1.3%")).toBeInTheDocument()
  })

  it("renders 0.0% for exactly zero growth, not N/A", () => {
    render(<GrowthBadge percent={0} />)
    expect(screen.getByText("0.0%")).toBeInTheDocument()
  })

  it("renders N/A text (not a fabricated 0%) when percent is null", () => {
    render(<GrowthBadge percent={null} />)
    expect(screen.getByText("N/A")).toBeInTheDocument()
  })

  it("exposes an accessible label carrying the same information as the visual text", () => {
    render(<GrowthBadge percent={12.5} label="Daily Gain" />)
    expect(screen.getByLabelText("Daily Gain: +12.5%")).toBeInTheDocument()
  })
})
