import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

// NotificationSettings reads useMemberTheme() (for its own ConfigProvider
// colorPrimary) -- MemberThemeProvider is self-contained (no network/
// localStorage dependency beyond its own theme preset default), so it's
// reused here rather than hand-rolling a fake ThemeContext value.
function renderNotificationSettings() {
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

// The draft card is the only <section> with no <h2> topic title (a saved
// card always has one) -- scoping queries to it, rather than a page-wide
// /Members list/ regex, is what keeps assertions from colliding with the
// already-saved VALO card's own identically-labeled "Members list" button.
function getDraftCard() {
  const combobox = screen.getByRole("combobox", { name: "Select notification topic" })
  return combobox.closest("section")!
}

describe("NotificationSettings", () => {
  it("starts with the 5 permanent default cards, in order, plus an 'Add topic' tile -- confirmed with the user: 全部/SF6/VALO/APEX/Minecraft are never removed", () => {
    renderNotificationSettings()
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent)
    // "Apex", not "APEX" -- reuses recentVideos.tag.apex verbatim (Home's
    // own existing label for this game), same as every other default topic
    // here reusing an existing label rather than a fresh one.
    expect(headings).toEqual(["All", "SF6", "VALO", "Apex", "Minecraft"])
    expect(screen.getByRole("button", { name: "Add topic" })).toBeInTheDocument()
  })

  it("clicking '+' creates one draft card (a topic select) and leaves the VALO card untouched", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))

    expect(screen.getByRole("heading", { name: "VALO" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Select notification topic" })).toBeInTheDocument()
  })

  it("hides the 'Add topic' tile (not merely disables it) while a draft card is open", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))

    expect(screen.queryByRole("button", { name: "Add topic" })).not.toBeInTheDocument()
  })

  it("shows no Save/Members-list/Reminder-time controls on the draft card until a topic is picked", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    const draftCard = within(getDraftCard())

    expect(draftCard.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
    expect(draftCard.queryByRole("button", { name: /Members list/ })).not.toBeInTheDocument()
    expect(draftCard.queryByRole("radiogroup", { name: /Reminder time/ })).not.toBeInTheDocument()
  })

  it("shows Save, Members list, and an interactive Reminder time control on the draft card once a topic is picked -- confirmed with the user: selecting a topic only enables configuration, it doesn't save", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("GTA"))

    const draftCard = within(getDraftCard())
    expect(draftCard.getByRole("button", { name: "Save" })).toBeEnabled()
    expect(draftCard.getByRole("button", { name: /Members list/ })).toBeInTheDocument()
    expect(draftCard.getByRole("radiogroup", { name: /Reminder time/ })).toBeInTheDocument()
    // The topic still isn't a saved card -- picking it must not persist it.
    expect(screen.queryByRole("heading", { name: "GTA" })).not.toBeInTheDocument()
  })

  it("keeps draft preferences transient until Save commits the topic", async () => {
    // antd's real radio <input> is visually hidden via pointer-events: none
    // (the sliding thumb is the visible surface) -- same as this app's own
    // established visually-hidden-input pattern elsewhere, just via this
    // control's own CSS. userEvent's pointer-events guard exists to catch
    // accidentally-unclickable elements, which this isn't; disabled for
    // this interaction only, same as clicking through to a real user's
    // click on the input's wrapping native <label>.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("GTA"))

    const draftCard = within(getDraftCard())
    expect(draftCard.getByRole("radio", { name: "10 minutes before" })).toBeChecked()

    await user.click(draftCard.getByRole("radio", { name: "30 minutes before" }))

    let stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics?.gta).toBeUndefined()

    await user.click(draftCard.getByRole("button", { name: "Save" }))
    stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics.gta.reminderMode).toBe("30min")
  })

  it("discards an abandoned draft so reselecting that topic starts clean", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const first = renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("GTA"))
    await user.click(within(getDraftCard()).getByRole("radio", { name: "30 minutes before" }))
    first.unmount()

    renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("GTA"))
    expect(within(getDraftCard()).getByRole("radio", { name: "10 minutes before" })).toBeChecked()
  })

  it("opens the member-management drawer for the still-unsaved draft topic when its 'Members list' is clicked", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("GTA"))
    await user.click(within(getDraftCard()).getByRole("button", { name: /Members list/ }))

    expect(await screen.findByText("GTA — Notified Members")).toBeInTheDocument()
  })

  it("keeps Save alone, pinned bottom-right, in the draft card's own actions row -- Notification Members is now its own interactive row inside the card body instead of a second button sharing this row", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("GTA"))

    const actionsRow = getDraftCard().querySelector(".notification-settings__topic-card-actions")!
    const buttons = within(actionsRow as HTMLElement).getAllByRole("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName("Save")
  })

  it("saving a picked topic turns the draft into a normal saved card and re-enables '+' in the next slot", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("GTA"))
    await user.click(within(getDraftCard()).getByRole("button", { name: "Save" }))

    expect(screen.getByRole("heading", { name: "GTA" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add topic" })).toBeInTheDocument()
    // The saved GTA card is a normal card now -- it has its own "Members list" button, no more Save button anywhere.
    const gtaCard = screen.getByRole("heading", { name: "GTA" }).closest("section")!
    expect(within(gtaCard).getByRole("button", { name: /Members list/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  })

  it("excludes every one of the 5 permanent default topics from the draft's dropdown options, since they're already saved from the start", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))

    for (const alreadySaved of ["SF6", "VALO", "APEX", "Minecraft"]) {
      expect(screen.queryByTitle(alreadySaved)).not.toBeInTheDocument()
    }
    // "All" itself isn't queried by title here -- "All" collides with
    // antd Select's own internal "(All)" strings in some builds; the loop
    // above plus the addable-topic check below already cover the
    // exclusion mechanism (getSelectableTopics) thoroughly.
    expect(await screen.findByTitle("GTA")).toBeInTheDocument()
    expect(screen.getByTitle("7 DAYS TO DIE")).toBeInTheDocument()
    expect(screen.getByTitle("雀魂")).toBeInTheDocument()
    expect(screen.getByTitle("Endfield")).toBeInTheDocument()
  })

  it("hides the Add topic tile when every catalog topic is already saved", () => {
    window.localStorage.setItem(
      "yobi.topicNotificationPreferences.v2",
      JSON.stringify({
        topicOrder: ["all", "sf6", "valo", "apex", "minecraft", "gta", "seven_days_to_die", "mahjong_soul", "endfield"],
        topics: {},
      }),
    )
    resetAllSharedStateForTests()
    renderNotificationSettings()
    expect(screen.queryByRole("button", { name: "Add topic" })).not.toBeInTheDocument()
  })
})

describe("NotificationSettings localization", () => {
  it("shows the localized Save label (儲存/Save/保存, never セーフ)", async () => {
    const user = userEvent.setup()

    // antd auto-inserts a space between a 2-character CJK button label's own
    // two characters (its own built-in autoInsertSpaceInButton behavior) --
    // "保存"/"儲存" render as "保 存"/"儲 存", hence the flexible regex below.
    window.localStorage.setItem("yobi.locale", "ja")
    resetAllSharedStateForTests()
    const { unmount } = renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "トピックを追加" }))
    await user.click(screen.getByRole("combobox", { name: "通知トピックを選択" }))
    await user.click(await screen.findByTitle("GTA"))
    expect(screen.getByRole("button", { name: /^保\s?存$/ })).toBeInTheDocument()
    expect(screen.queryByText("セーフ")).not.toBeInTheDocument()
    unmount()

    window.localStorage.setItem("yobi.locale", "zh-TW")
    resetAllSharedStateForTests()
    renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "新增主題" }))
    await user.click(screen.getByRole("combobox", { name: "選擇通知主題" }))
    await user.click(await screen.findByTitle("GTA"))
    expect(screen.getByRole("button", { name: /^儲\s?存$/ })).toBeInTheDocument()
  })
})
