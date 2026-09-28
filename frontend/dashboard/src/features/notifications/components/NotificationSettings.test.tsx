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

function getDetailPanel(): HTMLElement {
  return document.querySelector(".notification-detail-panel")!
}

async function pickGta(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
  await user.click(await screen.findByTitle("GTA"))
}

describe("NotificationSettings master-detail layout", () => {
  it("lists the 5 permanent default topics, in order, plus an Add topic tile -- confirmed with the user: 全部/SF6/VALO/APEX/Minecraft are never removed", () => {
    renderNotificationSettings()
    const names = [...document.querySelectorAll(".notification-topic-item__name")].map((el) => el.textContent)
    expect(names).toEqual(["All", "SF6", "VALO", "Apex", "Minecraft"])
    expect(screen.getByRole("heading", { level: 1, name: "Push Notifications" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add topic" })).toBeInTheDocument()
  })

  it("selects the first topic by default and shows its detail panel", () => {
    renderNotificationSettings()
    const detail = within(getDetailPanel())
    expect(detail.getByRole("heading", { level: 2, name: "All" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-current", "true")
  })

  it("switching to a different topic in the list updates the detail panel, without navigating away", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: /^VALO/ }))

    expect(within(getDetailPanel()).getByRole("heading", { level: 2, name: "VALO" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^VALO/ })).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: /^All/ })).not.toHaveAttribute("aria-current")
  })

  it("is keyboard-operable -- Enter on a focused topic button selects it, same as a click", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    screen.getByRole("button", { name: /^APEX|^Apex/ }).focus()
    await user.keyboard("{Enter}")

    expect(within(getDetailPanel()).getByRole("heading", { level: 2, name: "Apex" })).toBeInTheDocument()
  })

  it("clicking 'Add topic' opens a draft topic picker in the detail panel and hides the Add topic tile", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))

    expect(screen.getByRole("combobox", { name: "Select notification topic" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add topic" })).not.toBeInTheDocument()
  })

  it("shows no Save/Manage Members/reminder controls in the draft until a topic is picked", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    const detail = within(getDetailPanel())

    expect(detail.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
    expect(detail.queryByRole("button", { name: /Manage Members/ })).not.toBeInTheDocument()
    expect(detail.queryByRole("radiogroup", { name: /Live reminder time/ })).not.toBeInTheDocument()
  })

  it("shows Save, Manage Members, Live reminder time, and Notification type once a draft topic is picked -- confirmed with the user: picking a topic only enables configuration, it doesn't save", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)

    const detail = within(getDetailPanel())
    expect(detail.getByRole("button", { name: "Save" })).toBeEnabled()
    // Exactly one Manage Members entry point -- the redundant "個別成員設定"
    // section's own copy of this button was removed (confirmed with the
    // user: 管理成員 already owns all per-creator configuration, including
    // reminder overrides, so a second entry point implied two systems).
    expect(detail.getAllByRole("button", { name: /Manage Members/ })).toHaveLength(1)
    expect(detail.getByRole("radiogroup", { name: /Live reminder time/ })).toBeInTheDocument()
    expect(detail.getByRole("radiogroup", { name: /Notification type/ })).toBeInTheDocument()
    // The topic still isn't a saved card -- picking it must not persist it.
    expect(screen.queryByRole("button", { name: /^GTA/ })).not.toBeInTheDocument()
  })

  it("does not show the removed per-member-overrides section, only the single Manage Members entry point under Notified members", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: /^All/ }))

    const detail = within(getDetailPanel())
    expect(detail.queryByText("Per-member overrides (optional)")).not.toBeInTheDocument()
    expect(detail.queryByText(/have a custom reminder time/)).not.toBeInTheDocument()
    expect(detail.getByText("Notified members")).toBeInTheDocument()
    expect(detail.getAllByRole("button", { name: /Manage Members/ })).toHaveLength(1)

    await user.click(detail.getByRole("button", { name: /Manage Members/ }))
    expect(await screen.findByText("All — Notified Members")).toBeInTheDocument()
  })

  it("keeps draft preferences transient until Save commits the topic", async () => {
    // antd's real radio <input> is visually hidden via pointer-events: none
    // (the sliding thumb is the visible surface).
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)

    const detail = within(getDetailPanel())
    expect(detail.getByRole("radio", { name: "10 minutes before" })).toBeChecked()

    await user.click(detail.getByRole("radio", { name: "30 minutes before" }))

    let stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics?.gta).toBeUndefined()

    await user.click(detail.getByRole("button", { name: "Save" }))
    stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics.gta.reminderMode).toBe("30min")
  })

  // Regression test for the reminder-semantics correction's "verify state,
  // not just CSS" requirement: the underlying controlled value (and thus
  // the accessible checked state real screen readers/assistive tech would
  // see) must move to exactly one option per click, never leaving two
  // checked or the previous one stuck checked.
  it("Live reminder time is a real single-select: exactly one option is checked at a time as the value changes", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: /^All/ }))
    const detail = within(getDetailPanel())

    await user.click(detail.getByRole("radio", { name: "10 minutes before" }))
    expect(detail.getByRole("radio", { name: "10 minutes before" })).toBeChecked()
    expect(detail.getByRole("radio", { name: "30 minutes before" })).not.toBeChecked()
    expect(detail.getByRole("radio", { name: "1 hour before" })).not.toBeChecked()

    await user.click(detail.getByRole("radio", { name: "30 minutes before" }))
    expect(detail.getByRole("radio", { name: "10 minutes before" })).not.toBeChecked()
    expect(detail.getByRole("radio", { name: "30 minutes before" })).toBeChecked()
    expect(detail.getByRole("radio", { name: "1 hour before" })).not.toBeChecked()

    await user.click(detail.getByRole("radio", { name: "1 hour before" }))
    expect(detail.getByRole("radio", { name: "10 minutes before" })).not.toBeChecked()
    expect(detail.getByRole("radio", { name: "30 minutes before" })).not.toBeChecked()
    expect(detail.getByRole("radio", { name: "1 hour before" })).toBeChecked()
  })

  it("explains that the stream-start notification is guaranteed and reminder options are an additional pre-live notice", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: /^All/ }))

    expect(
      within(getDetailPanel()).getByText(
        "A notification is always sent when the stream starts. If you choose an earlier time, an additional reminder will be sent before the stream.",
      ),
    ).toBeInTheDocument()
  })

  it("discards an abandoned draft so reselecting that topic starts clean", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const first = renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    await user.click(within(getDetailPanel()).getByRole("radio", { name: "30 minutes before" }))
    first.unmount()

    renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    expect(within(getDetailPanel()).getByRole("radio", { name: "10 minutes before" })).toBeChecked()
  })

  it("selecting an already-saved topic while a draft is open abandons the draft", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    await user.click(within(getDetailPanel()).getByRole("radio", { name: "30 minutes before" }))

    await user.click(screen.getByRole("button", { name: /^VALO/ }))

    expect(within(getDetailPanel()).getByRole("heading", { level: 2, name: "VALO" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add topic" })).toBeInTheDocument()

    const stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics?.gta).toBeUndefined()
  })

  it("opens the member-management drawer for the still-unsaved draft topic when Manage Members is clicked", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])

    expect(await screen.findByText("GTA — Notified Members")).toBeInTheDocument()
  })

  it("saving a picked topic turns the draft into a normal list item, selects it, and re-enables Add topic", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    await user.click(within(getDetailPanel()).getByRole("button", { name: "Save" }))

    expect(screen.getByRole("button", { name: /^GTA/ })).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: "Add topic" })).toBeInTheDocument()
    // The saved GTA topic is a normal topic now -- Reset instead of Save.
    const detail = within(getDetailPanel())
    expect(detail.getByRole("heading", { level: 2, name: "GTA" })).toBeInTheDocument()
    expect(detail.getByRole("button", { name: /^Reset/ })).toBeInTheDocument()
    expect(detail.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  })

  it("excludes every one of the 5 permanent default topics from the draft's dropdown options, since they're already saved from the start", async () => {
    const user = userEvent.setup()
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))

    for (const alreadySaved of ["SF6", "VALO", "APEX", "Minecraft"]) {
      expect(screen.queryByTitle(alreadySaved)).not.toBeInTheDocument()
    }
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

  it("defaults a topic's notification type to Both, and persists a change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const detail = within(getDetailPanel())
    expect(detail.getByRole("radio", { name: "Live + New Video" })).toBeChecked()

    await user.click(detail.getByRole("radio", { name: "Live" }))

    const stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics.all.notificationType).toBe("live")
  })

  it("offers 1 minute before as a Live reminder time option, alongside the existing four", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const detail = within(getDetailPanel())
    await user.click(detail.getByRole("radio", { name: "1 minute before" }))

    const stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics.all.reminderMode).toBe("1min")
  })

  // The per-member-overrides section that used to show this count in the
  // detail panel was removed (its own "Manage Members" entry point was
  // redundant with the one under Notified members) -- the topic list's own
  // badge (TopicListItem) is the only remaining surface for this count, so
  // that's what this now verifies instead of the removed section's text.
  it("shows the topic-list override badge as the default label for a fresh topic, and a live count once one is set", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const topicCard = screen.getByRole("button", { name: /^All/ })
    expect(within(topicCard).getByText("Per-member overrides (optional)")).toBeInTheDocument()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])
    await user.click(screen.getAllByRole("switch", { name: /live notifications/ })[0])
    const reminderTrigger = screen.getAllByRole("button", { name: /'s reminder time/ })[0]
    await user.click(reminderTrigger)
    await user.click(screen.getByRole("menuitem", { name: "1 hour before" }))
    await user.keyboard("{Escape}")

    expect(await within(topicCard).findByText("1 custom")).toBeInTheDocument()
  })

  it("Reset restores a saved topic's own reminder mode and notification type, without touching enabled members", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])
    await user.click(screen.getAllByRole("switch", { name: /live notifications/ })[0])
    await user.keyboard("{Escape}")

    const detail = within(getDetailPanel())
    await user.click(detail.getByRole("radio", { name: "30 minutes before" }))
    await user.click(detail.getByRole("radio", { name: "Live" }))

    await user.click(detail.getByRole("button", { name: /^Reset/ }))

    expect(detail.getByRole("radio", { name: "10 minutes before" })).toBeChecked()
    expect(detail.getByRole("radio", { name: "Live + New Video" })).toBeChecked()
    expect(detail.getByText("1 selected")).toBeInTheDocument()
  })
})

// The topic-level notificationType is the single source of truth for which
// member-level channels the Manage Members drawer can ever show -- an
// excluded channel's whole column (switch, and reminder-time since that's
// Live-specific) is removed, not merely disabled, so the drawer never
// visually implies a channel is still part of a topic that no longer sends
// it (confirmed with the user, correcting an earlier version of this
// feature where the drawer showed both switches unconditionally).
describe("member drawer respects the topic's own notificationType", () => {
  function seedAllTopicType(notificationType: "live" | "newVideo" | "both") {
    window.localStorage.setItem(
      "yobi.topicNotificationPreferences.v2",
      JSON.stringify({
        topicOrder: ["all", "sf6", "valo", "apex", "minecraft"],
        topics: { all: { reminderMode: "10min", live: [], newVideo: [], reminderOverrides: {}, notificationType } },
      }),
    )
    resetAllSharedStateForTests()
  }

  it("newVideo topic: hides Live and reminder-time entirely, keeps New Video available", async () => {
    seedAllTopicType("newVideo")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])

    expect(screen.getByText("Notification type: New Video")).toBeInTheDocument()
    expect(screen.getAllByRole("switch", { name: /new video notifications/ }).length).toBeGreaterThan(0)
    expect(screen.queryByRole("switch", { name: /live notifications/ })).not.toBeInTheDocument()
    expect(screen.queryByText("Reminder time")).not.toBeInTheDocument()
  })

  // A newVideo-only topic never sends a live/stream-start notification, so
  // this control has nothing to configure -- but per the user's correction
  // it stays visible and disabled (not hidden, which made the section look
  // like it had vanished) rather than being removed from the page; only
  // the topic-list card's own summary badge (a separate, smaller claim)
  // still disappears.
  it("newVideo topic: keeps the top-level Live reminder time control visible but disabled, with its stored value preserved and untouchable", async () => {
    seedAllTopicType("newVideo")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const detail = within(getDetailPanel())
    const radiogroup = detail.getByRole("radiogroup", { name: /Live reminder time/ })
    expect(radiogroup).toBeInTheDocument()
    expect(radiogroup).toHaveClass("ant-segmented-disabled")
    expect(detail.getByRole("radio", { name: "10 minutes before" })).toBeChecked()
    expect(detail.getByRole("radio", { name: "10 minutes before" })).toBeDisabled()
    expect(
      detail.getByText("Live reminder timing is unavailable while only New Video notifications are enabled."),
    ).toBeInTheDocument()

    // Disabled means unclickable, not just visually dimmed -- clicking a
    // different option must not change the stored value.
    await user.click(detail.getByRole("radio", { name: "1 hour before" }))
    const stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics.all.reminderMode).toBe("10min")

    const topicCard = screen.getByRole("button", { name: /^All/ })
    expect(within(topicCard).queryByText("10 minutes before")).not.toBeInTheDocument()
  })

  it("preserves the reminder mode across a newVideo -> live round trip", async () => {
    window.localStorage.setItem(
      "yobi.topicNotificationPreferences.v2",
      JSON.stringify({
        topicOrder: ["all", "sf6", "valo", "apex", "minecraft"],
        topics: {
          all: { reminderMode: "1hour", live: [], newVideo: [], reminderOverrides: {}, notificationType: "live" },
        },
      }),
    )
    resetAllSharedStateForTests()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const detail = within(getDetailPanel())
    expect(detail.getByRole("radio", { name: "1 hour before" })).toBeChecked()

    await user.click(detail.getByRole("radio", { name: "New Video" }))
    let stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics.all.reminderMode).toBe("1hour")
    expect(detail.getByRole("radio", { name: "1 hour before" })).toBeChecked()
    expect(detail.getByRole("radio", { name: "1 hour before" })).toBeDisabled()

    await user.click(detail.getByRole("radio", { name: "Live" }))
    stored = JSON.parse(window.localStorage.getItem("yobi.topicNotificationPreferences.v2") ?? "{}")
    expect(stored.topics.all.reminderMode).toBe("1hour")
    expect(detail.getByRole("radio", { name: "1 hour before" })).toBeChecked()
    expect(detail.getByRole("radio", { name: "1 hour before" })).not.toBeDisabled()
  })

  it("live topic: hides New Video, keeps Live and reminder-time available", async () => {
    seedAllTopicType("live")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])

    expect(screen.getByText("Notification type: Live")).toBeInTheDocument()
    expect(screen.getAllByRole("switch", { name: /live notifications/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Reminder time").length).toBeGreaterThan(0)
    expect(within(getDetailPanel()).getByRole("radiogroup", { name: /Live reminder time/ })).toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: /new video notifications/ })).not.toBeInTheDocument()
  })

  it("both topic (default): shows Live, New Video, and reminder-time together", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])

    expect(screen.getByText("Notification type: Both")).toBeInTheDocument()
    expect(screen.getAllByRole("switch", { name: /live notifications/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole("switch", { name: /new video notifications/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Reminder time").length).toBeGreaterThan(0)
  })

  it("changing the topic's notification type updates the already-open drawer's columns immediately", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])
    expect(screen.getAllByRole("switch", { name: /live notifications/ }).length).toBeGreaterThan(0)

    await user.click(within(getDetailPanel()).getByRole("radio", { name: "New Video" }))

    expect(screen.queryByRole("switch", { name: /live notifications/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole("switch", { name: /new video notifications/ }).length).toBeGreaterThan(0)
  })

  it("a stale stored Live preference from before the topic excluded Live does not count as an effectively enabled member", async () => {
    window.localStorage.setItem(
      "yobi.topicNotificationPreferences.v2",
      JSON.stringify({
        topicOrder: ["all", "sf6", "valo", "apex", "minecraft"],
        topics: { all: { reminderMode: "10min", live: ["aizawa_ema"], newVideo: [], reminderOverrides: {}, notificationType: "newVideo" } },
      }),
    )
    resetAllSharedStateForTests()
    renderNotificationSettings()

    expect(within(getDetailPanel()).getByText("0 selected")).toBeInTheDocument()
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
