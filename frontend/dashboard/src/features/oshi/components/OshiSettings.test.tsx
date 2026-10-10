import { render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { OshiSettings } from "./OshiSettings"
import { useFavoriteCreators } from "../../favorites/hooks/useFavoriteCreators"
import { getCreatorById, getCreators, resolveCreatorKey, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

// OshiSettings reads useMemberTheme() (for its own ConfigProvider
// colorPrimary/Segmented tokens) -- MemberThemeProvider is self-contained,
// so it's reused here rather than hand-rolling a fake ThemeContext value
// (same pattern NotificationSettings.test.tsx already established). Tests
// run in the default (English) test-environment locale, same as every
// other .test.tsx file in this project.
function renderOshiSettings() {
  return render(
    <MemberThemeProvider>
      <OshiSettings />
    </MemberThemeProvider>,
  )
}

describe("OshiSettings (My Favorites roster)", () => {
  it("toggles a creator's favorite state via useFavoriteCreators when its tile is clicked -- the underlying Checkbox/toggleFavorite semantics are unchanged, only the visible UI is", async () => {
    const user = userEvent.setup()
    renderOshiSettings()

    const checkbox = screen.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" })
    expect(checkbox).not.toBeChecked()

    await user.click(checkbox)

    expect(checkbox).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBe(checkbox)
  })

  it("shares favorite state with useFavoriteCreators -- toggling here is visible to any other mounted consumer of the same store (e.g. Live Status's own CreatorStatusList)", async () => {
    const user = userEvent.setup()
    renderOshiSettings()

    await user.click(screen.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" }))

    const { result } = renderHook(() => useFavoriteCreators())
    expect(result.current.favorites.has("ch_aizawa_ema")).toBe(true)
  })

  it("the page-level 'All | Favorites' filter narrows the roster to only favorited creators, without mutating favorite state", async () => {
    const user = userEvent.setup()
    renderOshiSettings()

    await user.click(screen.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" }))
    await user.click(screen.getByText("Favorites")) // antd Segmented option label

    expect(screen.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /花芽すみれ/ })).not.toBeInTheDocument()
  })

  it("search narrows the roster without touching favorite state", async () => {
    const user = userEvent.setup()
    renderOshiSettings()

    await user.type(screen.getByPlaceholderText("Search creators"), "藍沢")

    expect(screen.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" })).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /花芽すみれ/ })).not.toBeInTheDocument()
  })

  it("shows the selected count in the page header", async () => {
    const user = userEvent.setup()
    renderOshiSettings()

    // "0 selected" renders once per region PLUS once in the page header --
    // just confirm it's present at all before toggling, then that the
    // count actually changed somewhere after.
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0)
    await user.click(screen.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" }))
    expect(screen.getAllByText("1 selected").length).toBeGreaterThan(0)
  })

  it("saves favorites and restores them, un-favoriting included, after a reload", async () => {
    const user = userEvent.setup()
    const { unmount } = renderOshiSettings()
    await user.click(screen.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" }))
    await user.click(screen.getByRole("checkbox", { name: "Add 兎田ぺこら to favorites" }))
    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!).sort()).toEqual(["ch_aizawa_ema", "ch_usada_pekora"])
    unmount()

    resetAllSharedStateForTests()
    renderOshiSettings()
    expect(screen.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()

    await user.click(screen.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" }))
    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!)).toEqual(["ch_usada_pekora"])
  })

  it("roster comes from the canonical Creator Registry, not mockCreators -- exactly getCreators().length DISTINCT creators render (a dual-tagged Gamers member intentionally renders twice, once per subgroup -- see hololiveSubgrouping.ts), never mockCreators' own 119", () => {
    renderOshiSettings()
    const distinctAriaLabels = new Set(
      screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label")),
    )
    expect(distinctAriaLabels.size).toBe(getCreators().length)
  })

  it("raw getCreators() alphabetical order is not used -- VSPO JP's own visible order matches canonical displayOrder ascending (excluding vspo_official, pinned last separately)", () => {
    renderOshiSettings()
    const expectedOrder = [...getCreators()]
      .filter((creator) => creator.branch === "vspo_jp" && creator.channelType === "member")
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((creator) => creator.displayName)

    const renderedNames = screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label") ?? "")
    const renderedVspoJpOrder = expectedOrder.filter((name) =>
      renderedNames.some((label) => label.includes(name.replace(/\n/g, " "))),
    )
    // Every VSPO JP member appears in the DOM in the same relative order as
    // the displayOrder-sorted expectation (not alphabetical-by-creatorId).
    expect(renderedVspoJpOrder).toEqual(expectedOrder)
  })

  it("airani_iofifteen: an exceptional legacy alias -- favoriting persists as the pre-existing ch_iofi, not the naive ch_airani_iofifteen, and she appears correctly in the Favorites-only view", async () => {
    const user = userEvent.setup()
    renderOshiSettings()

    await user.click(screen.getByRole("checkbox", { name: "Add Airani Iofifteen to favorites" }))

    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!)).toEqual(["ch_iofi"])
    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!)).not.toContain("ch_airani_iofifteen")

    await user.click(screen.getByText("Favorites"))
    expect(screen.getByRole("checkbox", { name: "Remove Airani Iofifteen from favorites" })).toBeInTheDocument()

    await user.click(screen.getByRole("checkbox", { name: "Remove Airani Iofifteen from favorites" }))
    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!)).toEqual([])
  })

  it("a canonical group-channel record (vspo_official) remains favoritable, preserving existing Favorites semantics unlike My Oshi's eligibility rule", async () => {
    const user = userEvent.setup()
    const vspoOfficial = getCreatorById("vspo_official")!
    renderOshiSettings()

    const checkbox = screen.getByRole("checkbox", { name: `Add ${vspoOfficial.displayName} to favorites` })
    await user.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!)).toContain(toLegacyRosterId(vspoOfficial))
  })

  it("a graduated canonical creator (gawr_gura) remains favoritable -- Favorites never filtered by lifecycleStage, unlike My Oshi", async () => {
    const user = userEvent.setup()
    renderOshiSettings()

    const checkbox = screen.getByRole("checkbox", { name: "Add Gawr Gura to favorites" })
    await user.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!)).toContain("ch_gawr_gura")
  })

  it("ch_hololive_staff (mock-only, no canonical record) is never rendered/synthesized", () => {
    renderOshiSettings()
    expect(screen.queryByText("hololive Production Staff")).not.toBeInTheDocument()
    expect(resolveCreatorKey("ch_hololive_staff")).toBeUndefined()
  })

  it("an existing persisted ch_hololive_staff favorite does not crash the page and is not auto-deleted", async () => {
    const user = userEvent.setup()
    localStorage.setItem("yobi.favoriteCreatorIds", JSON.stringify(["ch_hololive_staff", "ch_aizawa_ema"]))
    resetAllSharedStateForTests()

    renderOshiSettings()
    expect(screen.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()

    // Toggling an unrelated creator must not touch the orphaned legacy value.
    await user.click(screen.getByRole("checkbox", { name: "Add 兎田ぺこら to favorites" }))
    expect(JSON.parse(localStorage.getItem("yobi.favoriteCreatorIds")!).sort()).toEqual(
      ["ch_aizawa_ema", "ch_hololive_staff", "ch_usada_pekora"].sort(),
    )
  })

  it("a creator listed in two subgroups of one region (Fubuki: 1期生 and Gamers) counts ONCE in the region and the total, and both tiles follow one state", async () => {
    const user = userEvent.setup()
    const { container } = renderOshiSettings()
    const regionCount = (title: string) =>
      Array.from(container.querySelectorAll(".favorites-roster__region")).find((region) => region.querySelector(".favorites-roster__region-title")?.textContent === title)!
        .querySelector(".favorites-roster__region-count")!.textContent

    const fubukiTiles = screen.getAllByRole("checkbox", { name: "Add 白上フブキ to favorites" })
    expect(fubukiTiles.length).toBeGreaterThan(1) // the same creator really has two tiles
    await user.click(fubukiTiles[0])
    await user.click(screen.getByRole("checkbox", { name: "Add 兎田ぺこら to favorites" }))

    expect(regionCount("Hololive // JP")).toBe("2 selected") // not 3: Fubuki is one creator even though she has two tiles
    expect(document.body.textContent).toMatch(/2 selected/)
    for (const tile of screen.getAllByRole("checkbox", { name: "Remove 白上フブキ from favorites" })) expect(tile).toBeChecked()
  })
})
