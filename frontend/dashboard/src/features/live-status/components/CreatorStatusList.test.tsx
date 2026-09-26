import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CreatorStatusList, countLiveAndOffline } from "./CreatorStatusList"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { useFavoriteCreators } from "../../favorites/hooks/useFavoriteCreators"
import { useSelectedCreator } from "../../oshi/hooks/useSelectedCreator"
import type { CreatorStatus } from "../model/creatorStatus"

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
    // Shirakami Fubuki carries both "1期生" and "ゲーマーズ" tags, so she's
    // listed under both subgroups (same intentional dual-bucket rule as
    // Oshi/Notification Settings) -- two rows, not one.
    expect(screen.getAllByText("白上フブキ")).toHaveLength(2)
  })

  it("counts a live creator only once when she belongs to multiple subgroups", () => {
    renderList({
      statuses: { ...allOffline, ch_shirakami_fubuki: { kind: "live", videoId: "v1", title: "t1" } },
    })
    expect(screen.getByText("01 LIVE")).toBeInTheDocument()
    expect(screen.queryByText("02 LIVE")).not.toBeInTheDocument()
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

  it("opens the video when the status area is clicked for a live creator, for that same creator", async () => {
    const { onSelectVideo, onSelectCreator } = renderList({
      statuses: { ...allOffline, ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } },
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /LIVE/ }))
    // ch_aizawa_ema is also currentOshi's own default (mockCreators[0]), so
    // this is the "video for the creator already being viewed" path -- no
    // creator switch.
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "v1", title: "t1" }, "ch_aizawa_ema")
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
    expect(container.querySelector(".live-status-member__favorite-indicator")).not.toBeInTheDocument()
  })

  it("renders a favorite indicator only for the favorited creator", () => {
    const { container } = renderList({ favorites: new Set(["ch_aizawa_ema"]) })
    const rows = container.querySelectorAll(".live-status-member")
    const emaRow = [...rows].find((row) => row.textContent?.includes("藍沢エマ"))
    const fubukiRow = [...rows].find((row) => row.textContent?.includes("白上フブキ"))
    expect(emaRow?.querySelector(".live-status-member__favorite-indicator")).toBeInTheDocument()
    expect(fubukiRow?.querySelector(".live-status-member__favorite-indicator")).not.toBeInTheDocument()
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

// ch_aizawa_ema is currentOshi's own untouched default (mockCreators[0]),
// so a LIVE click on 白上フブキ (ch_shirakami_fubuki) below is always the
// "video belongs to another creator" case this describe block covers.
describe("CreatorStatusList video selection for a different creator", () => {
  const fubukiLive: Record<string, CreatorStatus> = {
    ...allOffline,
    ch_shirakami_fubuki: { kind: "live", videoId: "v2", title: "t2" },
  }

  it("opens the Oshi-switch confirm dialog instead of selecting the video when confirmOshiSwitch is true", async () => {
    const { onSelectCreator, onSelectVideo } = renderList({ statuses: fubukiLive, confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getAllByRole("button", { name: /LIVE/ })[0])
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(onSelectVideo).not.toHaveBeenCalled()
    expect(screen.getByText('Switch your Oshi to "白上フブキ"?')).toBeInTheDocument()
  })

  it("Cancel leaves both currentOshi and the selected video unchanged", async () => {
    const { onSelectCreator, onSelectVideo } = renderList({ statuses: fubukiLive, confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getAllByRole("button", { name: /LIVE/ })[0])
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it("confirming the switch both switches currentOshi and selects the video for the new creator", async () => {
    const { onSelectCreator, onSelectVideo } = renderList({ statuses: fubukiLive, confirmOshiSwitch: true })
    const user = userEvent.setup()
    await user.click(screen.getAllByRole("button", { name: /LIVE/ })[0])
    await user.click(screen.getByRole("button", { name: "Switch" }))
    expect(onSelectCreator).toHaveBeenCalledWith("ch_shirakami_fubuki")
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "v2", title: "t2" }, "ch_shirakami_fubuki")
  })

  it("switches currentOshi and selects the video immediately, with no dialog, when confirmOshiSwitch is false", async () => {
    const { onSelectCreator, onSelectVideo } = renderList({ statuses: fubukiLive, confirmOshiSwitch: false })
    const user = userEvent.setup()
    await user.click(screen.getAllByRole("button", { name: /LIVE/ })[0])
    expect(onSelectCreator).toHaveBeenCalledWith("ch_shirakami_fubuki")
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "v2", title: "t2" }, "ch_shirakami_fubuki")
    expect(screen.queryByText('Switch your Oshi to "白上フブキ"?')).not.toBeInTheDocument()
  })
})

function findRow(container: HTMLElement, name: string): HTMLElement {
  const rows = container.querySelectorAll(".live-status-member")
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
    fireEvent.click(row.querySelector(".live-status-member__creator-button")!)
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
    fireEvent.click(row.querySelector(".live-status-member__creator-button")!)
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
    fireEvent.click(row.querySelector(".live-status-member__status")!)
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
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "v1", title: "t1" }, "ch_aizawa_ema")
  })

  it("shows the localized 'Add Favorite' reveal label while dragging right past the swipe-start threshold", () => {
    const { container } = renderList({ locale: "zh-TW" })
    const row = findRow(container, "藍沢エマ")
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 30, clientY: 0 })
    // The reveal is a sibling of .live-status-member (both children of
    // the swipe wrapper), not a descendant of it -- see CreatorRow's markup.
    expect(row.parentElement!.querySelector(".live-status-member__reveal--left")).toHaveTextContent("加入收藏")
  })

  it("shows the localized 'Remove Favorite' reveal label (en/ja) while dragging left on a favorited creator", () => {
    const { container, rerender } = renderList({ favorites: new Set(["ch_aizawa_ema"]), locale: "en" })
    let row = findRow(container, "藍沢エマ")
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: -30, clientY: 0 })
    expect(row.parentElement!.querySelector(".live-status-member__reveal--right")).toHaveTextContent("Remove Favorite")

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
    expect(row.parentElement!.querySelector(".live-status-member__reveal--right")).toHaveTextContent("お気に入りから削除")
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
    expect(rowBBefore.querySelector(".live-status-member__favorite-indicator")).not.toBeInTheDocument()

    dragRow(rowA, 80) // commits Add Favorite in consumer A

    const rowBAfter = findRow(getByTestId("consumer-b"), "藍沢エマ")
    expect(rowBAfter.querySelector(".live-status-member__favorite-indicator")).toBeInTheDocument()
  })
})

// Mounts the real useSelectedCreator() store (not a mock) so clicking a row
// actually moves currentOshi the same way LiveScheduleDock's own setter
// does -- onSelectCreator here is that real setter, not vi.fn(). defaultOshi
// is left at its untouched fallback (mockCreators[0] = 藍沢エマ) throughout,
// matching the regression scenario: only currentOshi ever changes.
function RealCurrentOshi(overrides: Partial<React.ComponentProps<typeof CreatorStatusList>> = {}) {
  const [, setSelectedCreatorId] = useSelectedCreator()
  return (
    <CreatorStatusList
      statuses={allOffline}
      now={now}
      displayMode="absolute"
      language="en"
      query=""
      favorites={new Set()}
      onToggleFavorite={vi.fn()}
      onSelectCreator={setSelectedCreatorId}
      onSelectVideo={vi.fn()}
      locale="en"
      confirmOshiSwitch={false}
      onConfirmOshiSwitchChange={vi.fn()}
      {...overrides}
    />
  )
}

describe("CreatorStatusList MAIN vs CURRENT Oshi semantics", () => {
  it("defaultOshi === currentOshi: the same row shows MAIN and the selected/current rail", () => {
    const { container } = render(<RealCurrentOshi />)
    const row = findRow(container, "藍沢エマ")
    expect(row.querySelector(".live-status-member__main-badge")).toBeInTheDocument()
    expect(row.getAttribute("data-current-oshi")).toBe("true")
  })

  it("switching currentOshi moves the selected rail but leaves MAIN fixed on defaultOshi", async () => {
    const { container } = render(<RealCurrentOshi />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 花芽すみれ" }))

    const emaRow = findRow(container, "藍沢エマ")
    const sumireRow = findRow(container, "花芽すみれ")

    expect(emaRow.querySelector(".live-status-member__main-badge")).toBeInTheDocument()
    expect(emaRow.getAttribute("data-current-oshi")).toBe("false")

    expect(sumireRow.querySelector(".live-status-member__main-badge")).not.toBeInTheDocument()
    expect(sumireRow.getAttribute("data-current-oshi")).toBe("true")
  })

  it("switching to a third creator keeps MAIN fixed and moves the selected rail again", async () => {
    const { container } = render(<RealCurrentOshi />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 花芽すみれ" }))
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 花芽なずな" }))

    expect(findRow(container, "藍沢エマ").querySelector(".live-status-member__main-badge")).toBeInTheDocument()
    expect(findRow(container, "藍沢エマ").getAttribute("data-current-oshi")).toBe("false")
    expect(findRow(container, "花芽すみれ").getAttribute("data-current-oshi")).toBe("false")
    expect(findRow(container, "花芽なずな").getAttribute("data-current-oshi")).toBe("true")
    expect(findRow(container, "花芽なずな").querySelector(".live-status-member__main-badge")).not.toBeInTheDocument()
  })

  // The MAIN badge's color rule (home.css) reads --member-theme-color, this
  // row's own per-creator accent set as an inline style on
  // .live-status-member__creator-button -- never the global --creator-main
  // (currentOshi's color). jsdom doesn't apply the project's external
  // stylesheet, so this asserts the structural source (the inline custom
  // property itself) stays this creator's own value regardless of which
  // other row is currently selected, rather than a computed color.
  it("MAIN row's own per-row accent is unaffected by which creator is currently selected", async () => {
    const { container } = render(<RealCurrentOshi />)
    const emaButton = () => findRow(container, "藍沢エマ").querySelector(".live-status-member__creator-button") as HTMLElement
    const accentBefore = emaButton().style.getPropertyValue("--member-theme-color")
    expect(accentBefore).not.toBe("")

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch Oshi to 花芽すみれ" }))

    expect(emaButton().style.getPropertyValue("--member-theme-color")).toBe(accentBefore)
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
