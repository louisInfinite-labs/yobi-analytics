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

  it("offers individual creators but not staff, VSPO's official channel, or a pre_debut group channel", () => {
    renderMyOshiSettings()

    expect(screen.getByRole("radio", { name: /兎田ぺこら/ })).toBeInTheDocument()
    expect(screen.queryByText("hololive Production Staff")).not.toBeInTheDocument()
    expect(screen.queryByText("VSPO! Official")).not.toBeInTheDocument()
    // hololive_asobimawaritai: pre_debut but channelType "group" -- excluded
    // by the canonical rule (active/pre_debut member only), unlike the old
    // isEligibleForMyOshi which never excluded any Hololive group channel.
    expect(screen.queryByText("アソビ★まわり隊！")).not.toBeInTheDocument()
  })

  it("search never reveals an excluded creator (staff/group/graduated), even by exact name", async () => {
    const user = userEvent.setup()
    renderMyOshiSettings()
    const search = screen.getByPlaceholderText("Search creators")

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
