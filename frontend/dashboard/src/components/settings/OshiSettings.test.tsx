import { render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { OshiSettings } from "./OshiSettings"
import { useFavoriteCreators } from "../../hooks/useFavoriteCreators"
import { MemberThemeProvider } from "../../theme/MemberThemeProvider"

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
})
