import { render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { MyOshiSettings } from "./MyOshiSettings"
import { useDefaultOshiCreator } from "../hooks/useDefaultOshiCreator"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

const DEFAULT_KEY = "yobi.defaultOshiCreatorId"

/** Mounts the My Oshi picker under the theme provider it reads. */
function renderMyOshiSettings() {
  return render(
    <MemberThemeProvider>
      <MyOshiSettings />
    </MemberThemeProvider>,
  )
}

/** Clicks a creator's visible name label, as a user would (antd hides the radio input itself). */
async function pickCreator(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByText(name, { selector: ".my-oshi-select__slot-name" }))
}

/** Re-reads every persisted store from localStorage, as a fresh page load would. */
function simulateReload() {
  resetAllSharedStateForTests()
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("MyOshiSettings (default Oshi picker)", () => {
  it("shows the first roster creator as the current Main Oshi when nothing has been chosen", () => {
    renderMyOshiSettings()

    // Page title now follows the shared Settings header i18n (spec: header
    // renamed from "MAIN OSHI SELECT" to the localized nav label); the
    // featured-card "MAIN OSHI" badge below is unrelated and unchanged.
    expect(screen.getByRole("heading", { level: 1, name: "Oshi Settings" })).toBeInTheDocument()
    expect(screen.getByLabelText("Current Main Oshi: 藍沢エマ")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /藍沢エマ/ })).toBeChecked()
  })

  it("offers individual creators but not staff, VSPO's official channel, or the アソビ★まわり隊！ group channel itself", () => {
    renderMyOshiSettings()

    expect(screen.getByRole("radio", { name: /兎田ぺこら/ })).toBeInTheDocument()
    expect(screen.queryByText("hololive Production Staff")).not.toBeInTheDocument()
    expect(screen.queryByText("VSPO! Official")).not.toBeInTheDocument()
    // hololive_asobimawaritai (the GROUP channel record, channelType
    // "group") is excluded by the canonical rule, unlike the old
    // isEligibleForMyOshi which never excluded any Hololive group channel --
    // but her 4 real pre_debut MEMBERS are eligible and correctly render
    // under their own real アソビ★まわり隊！ subgroup heading (fixed grouping
    // bug: they used to fall into "Other"), so only the group channel's own
    // radio option must be absent, not the subgroup heading text.
    expect(screen.queryByRole("radio", { name: "アソビ★まわり隊！" })).not.toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /百灯キョーコ/ })).toBeInTheDocument()
    expect(screen.getByText("アソビ★まわり隊！", { selector: ".my-oshi-select__subgroup-title" })).toBeInTheDocument()
  })

  it("offers graduated individual creators, and a graduated creator can be selected as Main Oshi and survives a reload", async () => {
    const user = userEvent.setup()
    const { unmount } = renderMyOshiSettings()

    expect(screen.getByRole("radio", { name: /Gawr Gura/ })).toBeInTheDocument()
    await pickCreator(user, "Gawr Gura")

    expect(screen.getByLabelText("Current Main Oshi: Gawr Gura")).toBeInTheDocument()
    expect(localStorage.getItem(DEFAULT_KEY)).toBe("ch_gawr_gura")
    unmount()

    simulateReload()
    renderMyOshiSettings()

    expect(screen.getByLabelText("Current Main Oshi: Gawr Gura")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Gawr Gura/ })).toBeChecked()
  })

  it("an existing graduated Oshi selection stays valid -- it is shown as the current Main Oshi, not reset", () => {
    localStorage.setItem(DEFAULT_KEY, "ch_gawr_gura")
    resetAllSharedStateForTests()

    renderMyOshiSettings()

    expect(screen.getByLabelText("Current Main Oshi: Gawr Gura")).toBeInTheDocument()
  })

  it("search finds a graduated creator but never reveals a staff/group/official channel, even by exact name", async () => {
    const user = userEvent.setup()
    renderMyOshiSettings()
    const search = screen.getByPlaceholderText("Search creators")

    await user.type(search, "Gawr")
    expect(screen.getByRole("radio", { name: /Gawr Gura/ })).toBeInTheDocument()
    await user.clear(search)

    await user.type(search, "VSPO! Official")
    expect(screen.getByText("No creators found")).toBeInTheDocument()
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, "hololive Production Staff")
    expect(screen.getByText("No creators found")).toBeInTheDocument()

    await user.clear(search)
    await user.type(search, "アソビ★まわり隊！")
    expect(screen.getByText("No creators found")).toBeInTheDocument()
  })

  it("selecting a creator updates the presentation panel and persists the choice", async () => {
    const user = userEvent.setup()
    renderMyOshiSettings()

    await pickCreator(user, "兎田ぺこら")

    expect(screen.getByLabelText("Current Main Oshi: 兎田ぺこら")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /兎田ぺこら/ })).toBeChecked()
    expect(localStorage.getItem(DEFAULT_KEY)).toBe("ch_usada_pekora")
  })

  it("restores the saved choice after a reload and shares it with other consumers of the setting", async () => {
    const user = userEvent.setup()
    const { unmount } = renderMyOshiSettings()
    await pickCreator(user, "兎田ぺこら")
    unmount()

    simulateReload()
    renderMyOshiSettings()

    expect(screen.getByLabelText("Current Main Oshi: 兎田ぺこら")).toBeInTheDocument()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe("ch_usada_pekora")
  })

  it("narrows the roster with search and shows an empty state when nothing matches", async () => {
    const user = userEvent.setup()
    renderMyOshiSettings()
    const search = screen.getByPlaceholderText("Search creators")

    await user.type(search, "兎田")
    expect(screen.getByRole("radio", { name: /兎田ぺこら/ })).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: /藍沢エマ/ })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, "zzzz-no-such-creator")
    expect(screen.getByText("No creators found")).toBeInTheDocument()
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
  })

  it("Airani Iofifteen: an exceptional legacy alias -- persists as the pre-existing ch_iofi, not the naive ch_airani_iofifteen", async () => {
    const user = userEvent.setup()
    const { unmount } = renderMyOshiSettings()

    await pickCreator(user, "Airani Iofifteen")

    expect(screen.getByLabelText("Current Main Oshi: Airani Iofifteen")).toBeInTheDocument()
    expect(localStorage.getItem(DEFAULT_KEY)).toBe("ch_iofi")
    expect(localStorage.getItem(DEFAULT_KEY)).not.toBe("ch_airani_iofifteen")
    // Still consumable by the current, not-yet-migrated mockCreators-based
    // Home/CreatorStatusList path (their own MAIN-badge/seed comparison is
    // `creator.channelId === defaultOshiId`) -- this only holds if the
    // persisted value is a real mockCreators.channelId.
    expect(mockCreators.some((creator) => creator.channelId === "ch_iofi")).toBe(true)
    unmount()

    simulateReload()
    renderMyOshiSettings()
    expect(screen.getByLabelText("Current Main Oshi: Airani Iofifteen")).toBeInTheDocument()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe("ch_iofi")
  })

  it("searching does not change the saved Main Oshi", async () => {
    const user = userEvent.setup()
    renderMyOshiSettings()

    await user.type(screen.getByPlaceholderText("Search creators"), "兎田")

    expect(localStorage.getItem(DEFAULT_KEY)).toBeNull()
    expect(screen.getByLabelText("Current Main Oshi: 藍沢エマ")).toBeInTheDocument()
  })
})
