/** The member-notification drawer's UI fixes: (4) the phone's Live / New Video controls are square checkboxes (switches stay on tablet and
 * desktop), (5) the unset reminder reads 開播時 instead of a dash and picking it stores the existing at-start value, (6) the drawer's reminder
 * column is labelled 直播提醒時間 (and only there), (7) the notification-type description speaks of a member. Same values, same push gate, same
 * persistence as the switches -- only the control and the wording change. */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import * as liveReminderApi from "../api/liveReminderApi"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"
import { t } from "../../../shared/i18n/translations"
import { readStylesheet, ruleBody } from "../../../test/readStylesheet"

// Each render here mounts the whole ~120-creator roster; under a loaded machine (CI) the default 5s is not enough.
vi.setConfig({ testTimeout: 20_000 })

vi.mock("../push/pushGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../push/pushGate")>()),
  ensurePushEnabled: vi.fn(async () => "ready"),
}))
vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn().mockResolvedValue(undefined),
  deleteCreatorReminder: vi.fn().mockResolvedValue(undefined),
}))

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const SETTINGS_CSS = "src/pages/settings/styles/settings.css"
const TOPICS = [
  { id: "valorant", labels: { en: "VALO", "zh-TW": "VALO", ja: "VALO" } },
  { id: "sf6", labels: { en: "SF6", "zh-TW": "SF6", ja: "SF6" } },
  { id: "apex", labels: { en: "Apex", "zh-TW": "Apex", ja: "Apex" } },
  { id: "minecraft", labels: { en: "Minecraft", "zh-TW": "Minecraft", ja: "Minecraft" } },
  { id: "singing", labels: { en: "Singing", "zh-TW": "歌回", ja: "歌枠" } },
  { id: "mv", labels: { en: "MV", "zh-TW": "MV", ja: "MV" } },
  { id: "chatting", labels: { en: "Chatting", "zh-TW": "雜談", ja: "雑談" } },
  { id: "other", labels: { en: "Other", "zh-TW": "其他", ja: "その他" } },
]
type Locale = "zh-TW" | "en" | "ja"
const CHATTING_CARD: Record<Locale, RegExp> = { "zh-TW": /^雜談/, en: /^Chatting/, ja: /^雑談/ }
const MANAGE_MEMBERS = /Manage Members|管理成員|メンバーを管理|メンバー管理/

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

function renderSettings(width: number, locale: Locale = "en") {
  setViewport(width)
  localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

const storedState = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
const seed = (state: unknown) => window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))

/** Opens the Chatting topic's member drawer, on a phone (accordion) or a wider screen (master-detail). */
async function openChattingDrawer(user: ReturnType<typeof userEvent.setup>, locale: Locale = "en") {
  await user.click(await screen.findByRole("button", { name: CHATTING_CARD[locale] }))
  const panel = document.querySelector(".notification-detail-panel") as HTMLElement
  await user.click(within(panel).getAllByRole("button", { name: MANAGE_MEMBERS })[0])
  await screen.findByRole("dialog")
}

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue(TOPICS)
  vi.mocked(liveReminderApi.saveCreatorReminder).mockClear()
})

afterEach(() => {
  setViewport(1024)
})

describe("Fix 4 -- phone: square checkboxes instead of the ON/OFF switches", () => {
  it("Live and New Video are checkboxes on a phone, with no switch left in the drawer", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(390)
    await openChattingDrawer(user)

    expect(screen.getAllByRole("checkbox", { name: /live notifications/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole("checkbox", { name: /new video notifications/ }).length).toBeGreaterThan(0)
    expect(screen.queryAllByRole("switch")).toHaveLength(0)
    expect(document.querySelectorAll(".ant-switch")).toHaveLength(0)
  })

  it("shows a visible checked / unchecked state and toggles on click", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(390)
    await openChattingDrawer(user)
    const [live] = screen.getAllByRole("checkbox", { name: /live notifications/ })
    expect(live).not.toBeChecked()

    await user.click(live)
    expect(live).toBeChecked()
    await user.click(live)

    expect(live).not.toBeChecked()
  })

  it("persists exactly what the switch persisted: the same stored members, for Live and New Video", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(390)
    await openChattingDrawer(user)

    await user.click(screen.getAllByRole("checkbox", { name: /live notifications/ })[0])
    await user.click(screen.getAllByRole("checkbox", { name: /new video notifications/ })[1])

    const chatting = storedState().topics.chatting
    expect(chatting.live).toHaveLength(1)
    expect(chatting.newVideo).toHaveLength(1)
    expect(chatting.live[0]).not.toBe(chatting.newVideo[0]) // different members: each box wrote its own channel
  })

  it("is keyboard operable: Space toggles the focused checkbox", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(390)
    await openChattingDrawer(user)
    const [live] = screen.getAllByRole("checkbox", { name: /live notifications/ })
    live.focus()

    await user.keyboard(" ")

    expect(live).toBeChecked()
  })

  it("carries the same accessible name as the switch did (the member's name and the channel)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(390)
    await openChattingDrawer(user)

    const names = screen.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))
    expect(names.every((name) => /(live|new video) notifications$/.test(name ?? ""))).toBe(true)
  })

  it.each([768, 1024, 1366, 1920])("at %ipx (tablet / desktop) the ON/OFF switches are unchanged and there are no checkboxes", async (width) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(width)
    await openChattingDrawer(user)

    expect(screen.getAllByRole("switch", { name: /live notifications/ }).length).toBeGreaterThan(0)
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
  })

  it("the stylesheet makes it clearly square (equal sides, small radius), touch-sized (44px label), dark-themed and focus-visible", async () => {
    const css = await readStylesheet(SETTINGS_CSS)
    const box = ruleBody(css, ".topic-creator-drawer__checkbox-input")
    const label = ruleBody(css, ".topic-creator-drawer__checkbox")

    expect(/width:\s*(\d+)px/.exec(box)?.[1]).toBe(/height:\s*(\d+)px/.exec(box)?.[1]) // a square
    expect(Number(/border-radius:\s*(\d+)px/.exec(box)![1])).toBeLessThanOrEqual(4)
    expect(box).toMatch(/appearance:\s*none/)
    expect(label).toMatch(/min-width:\s*44px/)
    expect(label).toMatch(/min-height:\s*44px/)
    expect(ruleBody(css, ".topic-creator-drawer__checkbox-input:checked")).toMatch(/background:\s*var\(--oshi-select-highlight\)/)
    expect(ruleBody(css, ".topic-creator-drawer__checkbox-input:focus-visible")).toMatch(/outline:/)
  })
})

describe("Fix 5 -- the reminder selector reads 開播時, not a dash", () => {
  function seedLiveMember(reminder: string | null) {
    seed({
      topicOrder: ["all", "chatting", "singing", "mv", "apex"],
      topics: { chatting: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: reminder ? { aizawa_ema: reminder } : {}, notificationType: "both" } },
    })
  }
  const select = () => screen.getAllByRole("combobox", { name: /'s reminder time|的提醒時間|のリマインド時間/ })[0]

  it.each([
    ["zh-TW", "開播時"],
    ["en", "At start"],
    ["ja", "配信開始時"],
  ] as const)("%s: an unset reminder shows %s (never —), and the 開播時 option is in the list with its own value", async (locale, label) => {
    seedLiveMember(null)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024, locale)
    await openChattingDrawer(user, locale)

    expect(select()).toHaveDisplayValue(label)
    expect(select()).not.toHaveDisplayValue("—")
    const atStart = within(select()).getAllByRole("option", { hidden: true }).find((option) => (option as HTMLOptionElement).value === "at_start")
    expect(atStart).toHaveTextContent(label)
    expect(storedState().topics.chatting.reminderOverrides).toEqual({}) // showing it stores nothing
  })

  it("choosing 開播時 stores the existing at-start value and sends it to the backend exactly as before", async () => {
    seedLiveMember(null)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    await user.selectOptions(select(), "at_start")

    expect(storedState().topics.chatting.reminderOverrides).toEqual({ aizawa_ema: "at_start" })
    // the backend setting for "at start": notify at the stream start, with no advance reminder -- unchanged wire shape
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledTimes(1)
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "chatting", { notifyAtStart: true, advanceReminder: null })
  })

  it("the other reminder intervals are untouched", async () => {
    seedLiveMember("10min")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    expect(select()).toHaveDisplayValue("10 minutes before")
    expect(within(select()).getAllByRole("option", { hidden: true }).map((option) => (option as HTMLOptionElement).value)).toEqual(["at_start", "1min", "10min", "30min", "1hour"])
  })

  it("other dash placeholders are not touched (a member without Live shows the empty-cell dash)", async () => {
    seed({ topicOrder: ["all", "chatting", "singing", "mv", "apex"], topics: {} })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    expect(document.querySelector(".topic-creator-drawer__reminder-empty")?.textContent).toContain("—")
  })
})

describe("Fix 6 -- the drawer's reminder column is labelled 直播提醒時間, and only there", () => {
  it.each([
    ["zh-TW", "直播提醒時間"],
    ["en", "Live reminder time"],
    ["ja", "配信のリマインド時間"],
  ] as const)("%s: the member drawer's column header reads %s", async (locale, label) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024, locale)
    await openChattingDrawer(user, locale)

    expect(Array.from(document.querySelectorAll(".topic-creator-drawer__column-header-label")).map((node) => node.textContent)).toContain(label)
  })

  it("the generic 提醒時間 translations (and the per-member select's accessible name) are NOT renamed", () => {
    expect(t("zh-TW", "notificationSettings.reminderColumnHeader")).toBe("提醒時間")
    expect(t("en", "notificationSettings.reminderColumnHeader")).toBe("Reminder time")
    expect(t("zh-TW", "notificationSettings.reminderSelectAriaLabel", { name: "X" })).toBe("X 的提醒時間")
    expect(t("zh-TW", "notificationSettings.pageDescription")).toContain("提醒時間")
    expect(t("zh-TW", "notificationSettings.detailDescription", { topic: "T" })).toContain("提醒時間")
    expect(t("zh-TW", "notificationSettings.drawerReminderColumnHeader")).toBe("直播提醒時間")
  })
})

describe("Fix 7 -- the notification-type description speaks of a member", () => {
  it("zh-TW is exactly 選擇要收到這個成員的直播、新片通知, with en / ja equivalents; the topic wording is gone", () => {
    expect(t("zh-TW", "notificationSettings.notificationTypeSectionHelp")).toBe("選擇要收到這個成員的直播、新片通知")
    expect(t("en", "notificationSettings.notificationTypeSectionHelp")).toMatch(/this member/)
    expect(t("ja", "notificationSettings.notificationTypeSectionHelp")).toMatch(/メンバー/)
    expect(t("zh-TW", "notificationSettings.notificationTypeSectionHelp")).not.toContain("主題")
  })

  it("is what the type section shows, while the type options and other topic descriptions are unchanged", async () => {
    renderSettings(1024, "zh-TW")

    const panel = document.querySelector(".notification-detail-panel") as HTMLElement
    expect(panel.querySelector(".notification-detail-section__description")?.textContent).toBe("選擇要收到這個成員的直播、新片通知")
    expect(panel.querySelectorAll(".ant-segmented-item")).toHaveLength(3)
    expect(t("zh-TW", "notificationSettings.detailDescription", { topic: "T" })).toBe("設定「T」的提醒時間、通知類型與成員。")
  })
})
