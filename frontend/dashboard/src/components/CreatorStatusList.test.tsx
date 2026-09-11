import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CreatorStatusList, countLiveAndOffline } from "./CreatorStatusList"
import { mockCreators } from "../data/mockCreators"
import { useFavoriteCreators } from "../hooks/useFavoriteCreators"
import type { CreatorStatus } from "../types/creatorStatus"

const now = new Date("2026-09-09T12:00:00.000Z")
const allOffline: Record<string, CreatorStatus> = Object.fromEntries(mockCreators.map((c) => [c.channelId, { kind: "offline" as const }]))

function renderList(overrides: Partial<React.ComponentProps<typeof CreatorStatusList>> = {}) {
  const onSelectVideo = vi.fn()
  const onSelectCreator = vi.fn()
  const onToggleFavorite = vi.fn()
  const onConfirmOshiSwitchChange = vi.fn()
  const utils = render(
    <CreatorStatusList
      statuses={allOffline}
      now={now}
      displayMode="absolute"
      language="en"
      query=""
      favorites={new Set()}
      onToggleFavorite={onToggleFavorite}
      onSelectCreator={onSelectCreator}
      onSelectVideo={onSelectVideo}
      locale="en"
      // false by default so the existing "switches immediately" tests below
      // don't need to know about the confirmation dialog — its own behavior
      // is covered by the dedicated describe block further down.
      confirmOshiSwitch={false}
      onConfirmOshiSwitchChange={onConfirmOshiSwitchChange}
      {...overrides}
    />,
  )
  return { onSelectVideo, onSelectCreator, onToggleFavorite, onConfirmOshiSwitchChange, ...utils }
}

describe("CreatorStatusList", () => {
  it("lists every creator when favoriteOnlyIds is not set", () => {
    renderList()
    expect(screen.getByText("藍沢エマ")).toBeInTheDocument()
    expect(screen.getByText("白上フブキ")).toBeInTheDocument()
  })

  it("lists only the favorited creators when favoriteOnlyIds is set", () => {
    renderList({ favoriteOnlyIds: new Set(["ch_aizawa_ema"]) })
    expect(screen.getByText("藍沢エマ")).toBeInTheDocument()
    expect(screen.queryByText("白上フブキ")).not.toBeInTheDocument()
  })

  it("shows a favorites-specific empty message when the favorites set is empty", () => {
    renderList({ favoriteOnlyIds: new Set() })
    expect(screen.getByText(/No favorites yet/)).toBeInTheDocument()
  })

  it("calls onSelectCreator (not onSelectVideo/onToggleFavorite) when the avatar+name area is clicked", async () => {
    const { onSelectCreator, onSelectVideo, onToggleFavorite } = renderList()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    expect(onSelectCreator).toHaveBeenCalledWith("ch_aizawa_ema")
    expect(onSelectVideo).not.toHaveBeenCalled()
    expect(onToggleFavorite).not.toHaveBeenCalled()
  })

  it("opens the video when the status area is clicked for a live creator", async () => {
    const { onSelectVideo, onSelectCreator } = renderList({
      statuses: { ...allOffline, ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } },
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /LIVE/ }))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "v1", title: "t1" })
    expect(onSelectCreator).not.toHaveBeenCalled()
  })

  it("disables the status area for an offline creator", () => {
    renderList()
    const statusButtons = screen.getAllByRole("button", { name: /OFFLINE/ })
    for (const button of statusButtons) {
      expect(button).toBeDisabled()
    }
  })

  it("does not render a favorite indicator for a non-favorited creator", () => {
    const { container } = renderList()
    expect(container.querySelector(".creator-status-list__favorite-indicator")).not.toBeInTheDocument()
  })

  it("renders a favorite indicator only for the favorited creator", () => {
    const { container } = renderList({ favorites: new Set(["ch_aizawa_ema"]) })
    const rows = container.querySelectorAll(".creator-status-list__row")
    const emaRow = [...rows].find((row) => row.textContent?.includes("藍沢エマ"))
    const fubukiRow = [...rows].find((row) => row.textContent?.includes("白上フブキ"))
    expect(emaRow?.querySelector(".creator-status-list__favorite-indicator")).toBeInTheDocument()
    expect(fubukiRow?.querySelector(".creator-status-list__favorite-indicator")).not.toBeInTheDocument()
  })
})

describe("CreatorStatusList Oshi-switch confirmation", () => {
  it("opens the confirm dialog instead of switching immediately when confirmOshiSwitch is true", async () => {
    const { onSelectCreator } = renderList({ confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(screen.getByText('Switch your Oshi to "藍沢エマ"?')).toBeInTheDocument()
  })

  it("Cancel closes the dialog without switching or saving the preference, even if the checkbox was checked", async () => {
    const { onSelectCreator, onConfirmOshiSwitchChange } = renderList({ confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(onConfirmOshiSwitchChange).not.toHaveBeenCalled()
    expect(screen.queryByText('Switch your Oshi to "藍沢エマ"?')).not.toBeInTheDocument()
  })

  it("Switch without checking the box switches but does not save the preference", async () => {
    const { onSelectCreator, onConfirmOshiSwitchChange } = renderList({ confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    await user.click(screen.getByRole("button", { name: "Switch" }))
    expect(onSelectCreator).toHaveBeenCalledWith("ch_aizawa_ema")
    expect(onConfirmOshiSwitchChange).not.toHaveBeenCalled()
  })

  it("Switch with the box checked switches and saves confirmOshiSwitch=false", async () => {
    const { onSelectCreator, onConfirmOshiSwitchChange } = renderList({ confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Switch" }))
    expect(onSelectCreator).toHaveBeenCalledWith("ch_aizawa_ema")
    expect(onConfirmOshiSwitchChange).toHaveBeenCalledWith(false)
  })

  it("switches immediately with no dialog when confirmOshiSwitch is false", async () => {
    const { onSelectCreator } = renderList({ confirmOshiSwitch: false })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    expect(onSelectCreator).toHaveBeenCalledWith("ch_aizawa_ema")
    expect(screen.queryByText('Switch your Oshi to "藍沢エマ"?')).not.toBeInTheDocument()
  })
})

function findRow(container: HTMLElement, name: string): HTMLElement {
  const rows = container.querySelectorAll(".creator-status-list__row")
  return [...rows].find((row) => row.textContent?.includes(name)) as HTMLElement
}

function dragRow(row: HTMLElement, clientX: number) {
  fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(row, { pointerId: 1, clientX, clientY: 0 })
  fireEvent.pointerUp(row, { pointerId: 1, clientX, clientY: 0 })
}

describe("CreatorStatusList swipe-to-favorite", () => {
  it("J: gesture crosses 8px but not the 72px commit threshold -- no favorite action, no Oshi dialog, no YouTube action", () => {
    const { container, onToggleFavorite, onSelectCreator, onSelectVideo } = renderList({
      statuses: { ...allOffline, ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } },
    })
    const row = findRow(container, "藍沢エマ")
    dragRow(row, 30) // crosses the 8px swipe-start threshold, well short of +72px
    // A real mouse drag-then-release still fires a native click on release;
    // this simulates that so the suppression itself is under test.
    fireEvent.click(row.querySelector(".creator-status-list__creator-button")!)
    expect(onToggleFavorite).not.toHaveBeenCalled()
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it("K: a successful favorite swipe toggles favorite and suppresses the click -- no Oshi switch, no YouTube action", () => {
    const { container, onToggleFavorite, onSelectCreator, onSelectVideo } = renderList({
      statuses: { ...allOffline, ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } },
    })
    const row = findRow(container, "藍沢エマ")
    dragRow(row, 80) // past the +72px commit threshold
    fireEvent.click(row.querySelector(".creator-status-list__creator-button")!)
    expect(onToggleFavorite).toHaveBeenCalledWith("ch_aizawa_ema")
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it("L: a successful unfavorite swipe toggles favorite and suppresses the click -- no Oshi switch, no YouTube action", () => {
    const { container, onToggleFavorite, onSelectCreator, onSelectVideo } = renderList({
      favorites: new Set(["ch_aizawa_ema"]),
      statuses: { ...allOffline, ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } },
    })
    const row = findRow(container, "藍沢エマ")
    dragRow(row, -80) // past the -72px commit threshold
    fireEvent.click(row.querySelector(".creator-status-list__status-button")!)
    expect(onToggleFavorite).toHaveBeenCalledWith("ch_aizawa_ema")
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it("M: with movement below 8px, Avatar+Name click still opens the existing Oshi switch flow", async () => {
    const { onSelectCreator } = renderList({ confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" }))
    expect(onSelectCreator).not.toHaveBeenCalled() // gated behind the confirm dialog, not suppressed
    expect(screen.getByText('Switch your Oshi to "藍沢エマ"?')).toBeInTheDocument()
  })

  it("N: with movement below 8px, a LIVE status click still opens the existing YouTube flow", async () => {
    const { onSelectVideo } = renderList({
      statuses: { ...allOffline, ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } },
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /LIVE/ }))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "v1", title: "t1" })
  })

  it("shows the localized 'Add Favorite' reveal label while dragging right past the swipe-start threshold", () => {
    const { container } = renderList({ locale: "zh-TW" })
    const row = findRow(container, "藍沢エマ")
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 30, clientY: 0 })
    // The reveal is a sibling of .creator-status-list__row (both children of
    // the swipe wrapper), not a descendant of it -- see CreatorRow's markup.
    expect(row.parentElement!.querySelector(".creator-status-list__reveal--left")).toHaveTextContent("加入收藏")
  })

  it("shows the localized 'Remove Favorite' reveal label (en/ja) while dragging left on a favorited creator", () => {
    const { container, rerender } = renderList({ favorites: new Set(["ch_aizawa_ema"]), locale: "en" })
    let row = findRow(container, "藍沢エマ")
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: -30, clientY: 0 })
    expect(row.parentElement!.querySelector(".creator-status-list__reveal--right")).toHaveTextContent("Remove Favorite")

    rerender(
      <CreatorStatusList
        statuses={allOffline}
        now={now}
        displayMode="absolute"
        language="en"
        query=""
        favorites={new Set(["ch_aizawa_ema"])}
        onToggleFavorite={vi.fn()}
        onSelectCreator={vi.fn()}
        onSelectVideo={vi.fn()}
        locale="ja"
        confirmOshiSwitch={false}
        onConfirmOshiSwitchChange={vi.fn()}
      />,
    )
    row = findRow(container, "藍沢エマ")
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: -30, clientY: 0 })
    expect(row.parentElement!.querySelector(".creator-status-list__reveal--right")).toHaveTextContent("お気に入りから削除")
  })
})

function TwoConsumers() {
  const { favorites, toggleFavorite } = useFavoriteCreators()
  const props = {
    statuses: allOffline,
    now,
    displayMode: "absolute" as const,
    language: "en" as const,
    query: "",
    favorites,
    onToggleFavorite: toggleFavorite,
    onSelectCreator: vi.fn(),
    onSelectVideo: vi.fn(),
    locale: "en" as const,
    confirmOshiSwitch: false,
    onConfirmOshiSwitchChange: vi.fn(),
  }
  return (
    <>
      <div data-testid="consumer-a">
        <CreatorStatusList {...props} />
      </div>
      <div data-testid="consumer-b">
        <CreatorStatusList {...props} />
      </div>
    </>
  )
}

describe("CreatorStatusList swipe + shared favorites state", () => {
  it("committing a favorite swipe in one mounted CreatorStatusList updates another already-mounted one immediately", () => {
    const { getByTestId } = render(<TwoConsumers />)
    const rowA = findRow(getByTestId("consumer-a"), "藍沢エマ")
    const rowBBefore = findRow(getByTestId("consumer-b"), "藍沢エマ")
    expect(rowBBefore.querySelector(".creator-status-list__favorite-indicator")).not.toBeInTheDocument()

    dragRow(rowA, 80) // commits Add Favorite in consumer A

    const rowBAfter = findRow(getByTestId("consumer-b"), "藍沢エマ")
    expect(rowBAfter.querySelector(".creator-status-list__favorite-indicator")).toBeInTheDocument()
  })
})

describe("countLiveAndOffline", () => {
  const statuses: Record<string, CreatorStatus> = {
    ch_a: { kind: "live", videoId: "v1", title: "t" },
    ch_b: { kind: "offline" },
    ch_c: { kind: "offline" },
  }

  it("counts across every creator when favoriteOnlyIds is not set", () => {
    expect(countLiveAndOffline(statuses)).toEqual({ live: 1, offline: 2 })
  })

  it("counts only within favoriteOnlyIds when set", () => {
    expect(countLiveAndOffline(statuses, new Set(["ch_b"]))).toEqual({ live: 0, offline: 1 })
  })
})
