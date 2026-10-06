import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CreatorStatusList } from "./CreatorStatusList"

describe("CreatorStatusList uses the canonical creator color", () => {
  it("天音かなた's row accent is the canonical #76c0ea, not a frontend-owned color", () => {
    render(
      <CreatorStatusList
        statuses={{}}
        now={new Date("2026-09-09T12:00:00.000Z")}
        displayMode="absolute"
        query=""
        favorites={new Set()}
        onToggleFavorite={vi.fn()}
        onSelectCreator={vi.fn()}
        onSelectVideo={vi.fn()}
        locale="en"
        confirmOshiSwitch={false}
        onConfirmOshiSwitchChange={vi.fn()}
      />,
    )

    const button = screen.getByRole("button", { name: "Switch Oshi to 天音かなた" })

    expect(button.style.getPropertyValue("--member-theme-color").toLowerCase()).toBe("#76c0ea")
  })
})
