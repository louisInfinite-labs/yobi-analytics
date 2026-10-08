import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import * as liveReminderApi from "../api/liveReminderApi"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn().mockResolvedValue(undefined),
  deleteCreatorReminder: vi.fn().mockResolvedValue(undefined),
}))

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"

/** What GET /topics returns: the backend's canonical topics (including its "other" fallback). */
const BACKEND_TOPICS = ["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other"].map((id) => ({ id, labels: { en: id } }))

const UNSUPPORTED_TOPIC_MESSAGE = "This topic doesn't support its own notification yet; it follows the \"All\" setting."

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue(BACKEND_TOPICS)
  vi.mocked(liveReminderApi.saveCreatorReminder).mockClear()
  vi.mocked(liveReminderApi.deleteCreatorReminder).mockClear()
})

function storedState() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
}

function seedState(state: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  resetAllSharedStateForTests()
}

const DEFAULT_ORDER = ["all", "sf6", "valorant", "apex", "minecraft"]

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

  it("shows Save, Manage Members and Notification type once a draft topic is picked -- confirmed with the user: picking a topic only enables configuration, it doesn't save", async () => {
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
    expect(detail.getByRole("radiogroup", { name: /Notification type/ })).toBeInTheDocument()
    // No topic-level "forced time" control exists any more: reminders are set per creator.
    expect(detail.queryByRole("radiogroup", { name: /Live reminder time/ })).not.toBeInTheDocument()
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
    expect(detail.getByRole("radio", { name: "Live + New Video" })).toBeChecked()

    await user.click(detail.getByRole("radio", { name: "Live" }))

    expect(storedState().topics?.gta).toBeUndefined()

    await user.click(detail.getByRole("button", { name: "Save" }))
    expect(storedState().topics.gta.notificationType).toBe("live")
  })

  it("has no topic-level reminder time control: each creator's reminder is set in Manage Members", async () => {
    renderNotificationSettings()

    const detail = within(getDetailPanel())
    expect(detail.queryByRole("radiogroup", { name: /Live reminder time/ })).not.toBeInTheDocument()
    expect(detail.queryByText("Member's choice")).not.toBeInTheDocument()
    expect(detail.getByRole("radiogroup", { name: /Notification type/ })).toBeInTheDocument()
  })

  it("discards an abandoned draft so reselecting that topic starts clean", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const first = renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    await user.click(within(getDetailPanel()).getByRole("radio", { name: "Live" }))
    first.unmount()

    renderNotificationSettings()
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    expect(within(getDetailPanel()).getByRole("radio", { name: "Live + New Video" })).toBeChecked()
  })

  it("selecting an already-saved topic while a draft is open abandons the draft", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await pickGta(user)
    await user.click(within(getDetailPanel()).getByRole("radio", { name: "Live" }))

    await user.click(screen.getByRole("button", { name: /^VALO/ }))

    expect(within(getDetailPanel()).getByRole("heading", { level: 2, name: "VALO" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add topic" })).toBeInTheDocument()

    expect(storedState().topics?.gta).toBeUndefined()
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
    seedState({
      topicOrder: [...DEFAULT_ORDER, "gta", "seven_days_to_die", "mahjong_soul", "endfield"],
      topics: {},
    })
    renderNotificationSettings()
    expect(screen.queryByRole("button", { name: "Add topic" })).not.toBeInTheDocument()
  })

  it("defaults a topic's notification type to Both, and persists a change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const detail = within(getDetailPanel())
    expect(detail.getByRole("radio", { name: "Live + New Video" })).toBeChecked()

    await user.click(detail.getByRole("radio", { name: "Live" }))

    expect(storedState().topics.all.notificationType).toBe("live")
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

  it("Reset restores a saved topic's notification type, without touching enabled members", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])
    await user.click(screen.getAllByRole("switch", { name: /live notifications/ })[0])
    await user.keyboard("{Escape}")

    const detail = within(getDetailPanel())
    await user.click(detail.getByRole("radio", { name: "Live" }))

    await user.click(detail.getByRole("button", { name: /^Reset/ }))

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
    seedState({
      topicOrder: DEFAULT_ORDER,
      topics: { all: { live: [], newVideo: [], reminderOverrides: {}, notificationType } },
    })
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

  it("preserves members' reminders across a newVideo -> live round trip", async () => {
    seedState({
      topicOrder: DEFAULT_ORDER,
      topics: { all: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: { aizawa_ema: "1hour" }, notificationType: "live" } },
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const detail = within(getDetailPanel())
    await user.click(detail.getByRole("radio", { name: "New Video" }))
    expect(storedState().topics.all.reminderOverrides).toEqual({ aizawa_ema: "1hour" })

    await user.click(detail.getByRole("radio", { name: "Live" }))
    expect(storedState().topics.all.reminderOverrides).toEqual({ aizawa_ema: "1hour" })
  })

  it("live topic: hides New Video, keeps Live and reminder-time available", async () => {
    seedAllTopicType("live")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])

    expect(screen.getByText("Notification type: Live")).toBeInTheDocument()
    expect(screen.getAllByRole("switch", { name: /live notifications/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Reminder time").length).toBeGreaterThan(0)
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
    seedState({
      topicOrder: DEFAULT_ORDER,
      topics: { all: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: {}, notificationType: "newVideo" } },
    })
    renderNotificationSettings()

    expect(within(getDetailPanel()).getByText("0 selected")).toBeInTheDocument()
  })
})

// A creator's reminder is set per topic in Manage Members. "No reminder" (unset) is a real
// choice and the default; the creator's 全部 reminder shadows that creator's topic reminders
// without erasing them; a topic the backend doesn't support can't have its own reminder.
describe("member drawer reminders", () => {
  /** One Live-enabled creator in `topicId`, optionally with a reminder -- so the drawer shows exactly one reminder button. */
  function seedReminders(topics: Record<string, { reminder?: string }>, order: string[] = DEFAULT_ORDER) {
    seedState({
      topicOrder: order,
      topics: Object.fromEntries(
        Object.entries(topics).map(([id, { reminder }]) => [
          id,
          { live: ["aizawa_ema"], newVideo: [], reminderOverrides: reminder ? { aizawa_ema: reminder } : {}, notificationType: "both" },
        ]),
      ),
    })
  }

  async function openDrawerFor(user: ReturnType<typeof userEvent.setup>, topicButton: RegExp) {
    await user.click(screen.getByRole("button", { name: topicButton }))
    await user.click(within(getDetailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])
    return screen.findAllByRole("button", { name: /'s reminder time/ })
  }

  it("defaults a Live-enabled creator to 'No reminder' -- never to a time", async () => {
    seedReminders({ sf6: {} })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const [trigger] = await openDrawerFor(user, /^SF6/)

    expect(trigger).toHaveTextContent("No reminder")
  })

  it("offers 'No reminder' plus the five times, including 1 minute before", async () => {
    seedReminders({ sf6: {} })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const [trigger] = await openDrawerFor(user, /^SF6/)
    await user.click(trigger)

    const labels = screen.getAllByRole("menuitem").map((item) => item.textContent)
    expect(labels).toEqual(["No reminder", "At start", "1 minute before", "10 minutes before", "30 minutes before", "1 hour before"])
  })

  it("choosing a time stores it for that creator + topic and writes just that one backend item", async () => {
    seedReminders({ sf6: {} })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const [trigger] = await openDrawerFor(user, /^SF6/)
    await user.click(trigger)
    await user.click(screen.getByRole("menuitem", { name: "1 minute before" }))

    expect(storedState().topics.sf6.reminderOverrides).toEqual({ aizawa_ema: "1min" })
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledTimes(1)
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "sf6", { notifyAtStart: true, advanceReminder: "1min" })
  })

  it("choosing 'No reminder' unsets it and deletes only that one backend item", async () => {
    seedReminders({ sf6: { reminder: "10min" }, apex: { reminder: "30min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const [trigger] = await openDrawerFor(user, /^SF6/)
    expect(trigger).toHaveTextContent("10 minutes before")
    await user.click(trigger)
    await user.click(screen.getByRole("menuitem", { name: "No reminder" }))

    expect(storedState().topics.sf6.reminderOverrides).toEqual({})
    expect(storedState().topics.apex.reminderOverrides).toEqual({ aizawa_ema: "30min" })
    expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledTimes(1)
    expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "sf6")
  })

  it("shows a topic reminder as not in effect while the same creator's 全部 reminder is set, and keeps it stored", async () => {
    seedReminders({ all: { reminder: "30min" }, sf6: { reminder: "10min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const [trigger] = await openDrawerFor(user, /^SF6/)

    expect(trigger).toHaveTextContent("10 minutes before")
    expect(screen.getByText('Not in effect (overridden by the "All" setting)')).toBeInTheDocument()
    expect(storedState().topics.sf6.reminderOverrides).toEqual({ aizawa_ema: "10min" })
  })

  it("does not show that hint on the 全部 reminder itself, or when 全部 is unset", async () => {
    seedReminders({ all: { reminder: "30min" }, sf6: { reminder: "10min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await openDrawerFor(user, /^All/)
    expect(screen.queryByText('Not in effect (overridden by the "All" setting)')).not.toBeInTheDocument()
  })

  it("setting 全部 never touches the creator's topic reminders, in storage or on the backend", async () => {
    seedReminders({ all: {}, sf6: { reminder: "10min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    const [trigger] = await openDrawerFor(user, /^All/)
    await user.click(trigger)
    await user.click(screen.getByRole("menuitem", { name: "30 minutes before" }))

    expect(storedState().topics.all.reminderOverrides).toEqual({ aizawa_ema: "30min" })
    expect(storedState().topics.sf6.reminderOverrides).toEqual({ aizawa_ema: "10min" })
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledTimes(1)
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "all", { notifyAtStart: true, advanceReminder: "30min" })
    expect(liveReminderApi.deleteCreatorReminder).not.toHaveBeenCalled()
  })

  it("turning Live off for a creator + topic deletes just that backend reminder item", async () => {
    seedReminders({ all: { reminder: "30min" }, sf6: { reminder: "10min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderNotificationSettings()

    await openDrawerFor(user, /^SF6/)
    await user.click(screen.getAllByRole("switch", { name: /live notifications/ }).find((el) => el.getAttribute("aria-checked") === "true")!)

    expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledTimes(1)
    expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "sf6")
    expect(storedState().topics.sf6.reminderOverrides).toEqual({})
    expect(storedState().topics.all.reminderOverrides).toEqual({ aizawa_ema: "30min" })
  })

  describe("a category the backend doesn't classify (display-only)", () => {
    const WITH_GTA = [...DEFAULT_ORDER, "gta"]

    it("stays visible in the topic list", () => {
      seedReminders({ gta: {} }, WITH_GTA)
      renderNotificationSettings()

      expect(screen.getByRole("button", { name: /^GTA/ })).toBeInTheDocument()
    })

    it("disables the reminder control and says it follows 全部", async () => {
      seedReminders({ gta: {} }, WITH_GTA)
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderNotificationSettings()

      const [trigger] = await openDrawerFor(user, /^GTA/)

      expect(trigger).toBeDisabled()
      expect(await screen.findByText(UNSUPPORTED_TOPIC_MESSAGE)).toBeInTheDocument()
    })

    it("never writes an independent backend reminder for it", async () => {
      seedReminders({ gta: {} }, WITH_GTA)
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderNotificationSettings()

      const [trigger] = await openDrawerFor(user, /^GTA/)
      await user.click(trigger)

      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
      expect(liveReminderApi.saveCreatorReminder).not.toHaveBeenCalled()
    })
  })

  describe("a category the backend classifies", () => {
    it("has an enabled reminder control and no 'unsupported' message -- SF6 (a default)", async () => {
      seedReminders({ sf6: {} })
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderNotificationSettings()

      const [sf6Trigger] = await openDrawerFor(user, /^SF6/)
      await waitFor(() => expect(sf6Trigger).toBeEnabled())
      expect(screen.queryByText(UNSUPPORTED_TOPIC_MESSAGE)).not.toBeInTheDocument()
    })

    it("treats the 全部 scope as always supported, even if GET /topics fails", async () => {
      vi.mocked(fetchVideoTopics).mockRejectedValue(new Error("offline"))
      seedReminders({ all: {} })
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderNotificationSettings()

      const [trigger] = await openDrawerFor(user, /^All/)

      expect(trigger).toBeEnabled()
      expect(screen.queryByText(UNSUPPORTED_TOPIC_MESSAGE)).not.toBeInTheDocument()
    })
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
