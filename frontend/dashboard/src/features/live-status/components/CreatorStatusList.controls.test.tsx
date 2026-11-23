/** Live Status rows switch creator with an in-app control, never a link: there are no per-creator pages, so no row carries a /creator/... URL.
 * The click, keyboard and confirmation behaviour is the button's own (covered in CreatorStatusList.test.tsx); here: the row is a <button>, no
 * creator URL is rendered anywhere in the list, and the status reads as unknown (never OFFLINE) until live data exists. */
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CreatorStatusList } from "./CreatorStatusList"
import { getCreators, isLiveStatusDisplayEligible } from "../../../entities/creator/data/creatorRegistry"
import type { CreatorStatus } from "../model/creatorStatus"

vi.setConfig({ testTimeout: 20_000 })

const now = new Date("2026-09-09T12:00:00.000Z")

function renderList(overrides: Partial<React.ComponentProps<typeof CreatorStatusList>> = {}) {
  const onSelectCreator = vi.fn()
  render(
    <CreatorStatusList
      statuses={{}}
      now={now}
      displayMode="absolute"
      query=""
      favorites={new Set()}
      onToggleFavorite={vi.fn()}
      onSelectCreator={onSelectCreator}
      onSelectVideo={vi.fn()}
      locale="en"
      confirmOshiSwitch={false}
      onConfirmOshiSwitchChange={vi.fn()}
      {...overrides}
    />,
  )
  return { onSelectCreator }
}

describe("CreatorStatusList creator controls", () => {
  it("every displayed creator is a <button type=button>, and the list renders no link at all", () => {
    renderList()
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".live-status-member__creator-button"))
    // One creator can be listed in two subgroups (production shows 120 rows for 119 creators): count distinct creators.
    expect(new Set(rows.map((row) => row.getAttribute("aria-label"))).size).toBe(getCreators().filter(isLiveStatusDisplayEligible).length)
    expect(rows.every((row) => row.tagName === "BUTTON" && row.getAttribute("type") === "button")).toBe(true)
    expect(document.querySelectorAll("a")).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain("/creator")
  })

  it("a click switches creator through the existing handler", () => {
    const { onSelectCreator } = renderList()
    fireEvent.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    expect(onSelectCreator).toHaveBeenCalledExactlyOnceWith("ch_aizawa_ema")
  })

  it("before live data exists, every status is a neutral dash: never OFFLINE, never a LIVE count, not clickable", () => {
    const live: Record<string, CreatorStatus> = { ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } }
    renderList({ statuses: live, statusKnown: false })
    const cells = Array.from(document.querySelectorAll<HTMLButtonElement>(".live-status-member__status"))
    expect(cells.length).toBeGreaterThan(100)
    expect(cells.every((cell) => cell.textContent === "—" && cell.disabled && cell.dataset.status === "unknown")).toBe(true)
    expect(screen.queryByText("OFFLINE")).not.toBeInTheDocument()
    expect(screen.queryByText(/\d+ LIVE/)).not.toBeInTheDocument()
  })

  it("once live data exists, statuses render exactly as before", () => {
    renderList({ statuses: { ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } }, statusKnown: true })
    expect(screen.getAllByRole("button", { name: /LIVE/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByText("OFFLINE").length).toBeGreaterThan(100)
  })
})
