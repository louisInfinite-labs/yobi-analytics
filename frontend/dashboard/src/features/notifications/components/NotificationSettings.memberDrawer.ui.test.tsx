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
import { mediaBlocks, outsideMedia, readStylesheet, ruleBody } from "../../../test/readStylesheet"
import { closedReminderText } from "../../../test/reminderSelect"

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

describe("Fix 2 -- the reminder dropdown lists 開播時 exactly once", () => {
  function seedLiveMember(reminder: string | null) {
    seed({
      topicOrder: ["all", "chatting", "singing", "mv", "apex"],
      topics: { chatting: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: reminder ? { aizawa_ema: reminder } : {}, notificationType: "both" } },
    })
  }
  const select = () => screen.getAllByRole("combobox", { name: /'s reminder time|的提醒時間|のリマインド時間/ })[0] as HTMLSelectElement
  const optionValues = () => Array.from(select().options).map((option) => option.value)
  const optionTexts = () => Array.from(select().options).map((option) => option.textContent)

  it.each([
    ["zh-TW", ["開播時", "1 分鐘前", "10 分鐘前", "30 分鐘前", "1 小時前"]],
    ["en", ["At start", "1 minute before", "10 minutes before", "30 minutes before", "1 hour before"]],
    ["ja", ["配信開始時", "1分前", "10分前", "30分前", "1時間前"]],
  ] as const)("%s: exactly five unique options, whether or not the member has a reminder yet", async (locale, labels) => {
    for (const reminder of [null, "10min", "at_start"]) {
      seedLiveMember(reminder)
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      const { unmount } = renderSettings(1024, locale)
      await openChattingDrawer(user, locale)

      expect(optionTexts()).toEqual(labels)
      expect(new Set(optionTexts()).size).toBe(5) // 開播時 once
      expect(optionValues()).toEqual(["at_start", "1min", "10min", "30min", "1hour"]) // the existing values, no empty-value duplicate
      expect(Array.from(select().options).every((option) => !option.hidden && !option.disabled)).toBe(true)
      unmount()
    }
  })

  it("a member with no reminder has nothing selected, so no option is checked twice; the closed control shows 開播時", async () => {
    seedLiveMember(null)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    expect(select().selectedIndex).toBe(-1)
    expect(closedReminderText(select())).toBe("At start")
    expect(storedState().topics.chatting.reminderOverrides).toEqual({}) // showing it stores nothing
  })

  it("choosing 開播時 from that state still stores the existing at-start setting and sends it exactly as before", async () => {
    seedLiveMember(null)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    await user.selectOptions(select(), "at_start")

    expect(storedState().topics.chatting.reminderOverrides).toEqual({ aizawa_ema: "at_start" })
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledTimes(1)
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "chatting", { notifyAtStart: true, advanceReminder: null })
    expect(select().selectedIndex).toBe(0) // now the one 開播時 option is the checked one
    expect(closedReminderText(select())).toBe("At start")
    expect(document.querySelector(".topic-creator-drawer__reminder-select-prompt")).toBeNull() // the prompt is gone once a timing is stored
  })

  it("a previously saved at-start preference shows 開播時 as the single checked option (compatible with stored data)", async () => {
    seedLiveMember("at_start")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    expect(select().selectedIndex).toBe(0)
    expect(select().value).toBe("at_start")
    expect(optionTexts().filter((text) => text === "At start")).toHaveLength(1)
  })

  it("every other timing still saves, and switching back to 開播時 stores at_start", async () => {
    seedLiveMember(null)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    await user.selectOptions(select(), "10min")
    expect(storedState().topics.chatting.reminderOverrides).toEqual({ aizawa_ema: "10min" })
    expect(select()).toHaveDisplayValue("10 minutes before")
    await user.selectOptions(select(), "at_start")

    expect(storedState().topics.chatting.reminderOverrides).toEqual({ aizawa_ema: "at_start" })
    expect(liveReminderApi.saveCreatorReminder).toHaveBeenLastCalledWith("aizawa_ema", "chatting", { notifyAtStart: true, advanceReminder: null })
  })

  it("the select keeps focus across a change (one element throughout)", async () => {
    seedLiveMember(null)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)
    const before = select()
    before.focus()

    await user.selectOptions(before, "30min")

    expect(select()).toBe(before)
  })

  it("other dash placeholders are not touched (a member without Live shows the empty-cell dash)", async () => {
    seed({ topicOrder: ["all", "chatting", "singing", "mv", "apex"], topics: {} })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024)
    await openChattingDrawer(user)

    expect(document.querySelector(".topic-creator-drawer__reminder-empty")?.textContent).toContain("—")
  })

  it("the prompt overlay is stylesheet-positioned over the select, takes no taps and uses the select's own type", async () => {
    const css = await readStylesheet(SETTINGS_CSS)
    const prompt = ruleBody(css, ".topic-creator-drawer__reminder-select-prompt")

    expect(prompt).toMatch(/position:\s*absolute/)
    expect(prompt).toMatch(/pointer-events:\s*none/)
    expect(prompt).toMatch(/font-size:\s*10px/)
    expect(ruleBody(css, ".topic-creator-drawer__reminder-select-wrap")).toMatch(/position:\s*relative/)
  })
})

const stripBreaks = (text: string | null | undefined) => (text ?? "").replace(/\u200B/g, "")

describe("Fix 6 -- the drawer's reminder column is labelled 直播提醒時間, and only there", () => {
  it.each([
    ["zh-TW", "直播提醒時間"],
    ["en", "Live reminder time"],
    ["ja", "配信のリマインド時間"],
  ] as const)("%s: the member drawer's column header reads %s (a soft break may sit inside it)", async (locale, label) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings(1024, locale)
    await openChattingDrawer(user, locale)

    expect(Array.from(document.querySelectorAll(".topic-creator-drawer__column-header-label")).map((node) => stripBreaks(node.textContent))).toContain(label)
  })

  it("the generic 提醒時間 translations (and the per-member select's accessible name) are NOT renamed", () => {
    expect(t("zh-TW", "notificationSettings.reminderColumnHeader")).toBe("提醒時間")
    expect(t("en", "notificationSettings.reminderColumnHeader")).toBe("Reminder time")
    expect(t("zh-TW", "notificationSettings.reminderSelectAriaLabel", { name: "X" })).toBe("X 的提醒時間")
    expect(t("zh-TW", "notificationSettings.pageDescription")).toContain("提醒時間")
    expect(stripBreaks(t("zh-TW", "notificationSettings.drawerReminderColumnHeader"))).toBe("直播提醒時間")
  })
})

describe("Fix 3 -- the phone's reminder column wraps its heading and fits", () => {
  it("the heading carries one soft break after the first word (zh 直播|提醒時間, ja 配信の|リマインド時間); English has none", () => {
    expect(t("zh-TW", "notificationSettings.drawerReminderColumnHeader")).toBe("直播\u200B提醒時間")
    expect(t("ja", "notificationSettings.drawerReminderColumnHeader")).toBe("配信の\u200Bリマインド時間")
    expect(t("en", "notificationSettings.drawerReminderColumnHeader")).toBe("Live reminder time")
  })

  it("on a phone the heading's box is narrower than the whole phrase, so it wraps at the break instead of clipping; the select keeps its full column", async () => {
    const css = await readStylesheet(SETTINGS_CSS)
    const phone = mediaBlocks(css, "(max-width: 560px)")

    const zh = ruleBody(phone, '.topic-creator-drawer__content[data-locale="zh-TW"] .topic-creator-drawer__column-header-label--reminder')
    const ja = ruleBody(phone, '.topic-creator-drawer__content[data-locale="ja"] .topic-creator-drawer__column-header-label--reminder')
    expect(zh).toMatch(/max-width:\s*5\.5em/) // 6 characters at 11px is 66px > 60.5px: wraps after 直播
    expect(ja).toMatch(/max-width:\s*8em/)
    expect(zh).toMatch(/word-break:\s*keep-all/)
    // never clipped: a heading wraps inside its own column
    expect(ruleBody(css, ".topic-creator-drawer__column-header-label")).toMatch(/overflow-wrap:\s*anywhere/)
    expect(ruleBody(css, ".topic-creator-drawer__column-header-label")).toMatch(/min-width:\s*0/)
    // the reminder column width and the Live / New Video checkbox columns are unchanged
    expect(ruleBody(css, ".topic-creator-drawer__row")).toMatch(/var\(--drawer-switch-col\) var\(--drawer-switch-col\) var\(--drawer-reminder-col\)/)
  })

  it("tablet and desktop are untouched: the heading box limits exist only inside the phone media query", async () => {
    const css = await readStylesheet(SETTINGS_CSS)

    expect(outsideMedia(css)).not.toContain("column-header-label--reminder")
  })

  it("the reminder select is full-width of its column and the column header class is on the reminder heading only", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    seed({ topicOrder: ["all", "chatting", "singing", "mv", "apex"], topics: { chatting: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: {}, notificationType: "both" } } })
    renderSettings(390, "zh-TW")
    await openChattingDrawer(user, "zh-TW")

    expect(document.querySelectorAll(".topic-creator-drawer__column-header-label--reminder").length).toBeGreaterThan(0)
    expect(document.querySelector(".topic-creator-drawer__column-header-label--reminder")?.textContent).toContain("提醒時間")
    expect(ruleBody(await readStylesheet(SETTINGS_CSS), ".topic-creator-drawer__reminder-select")).toMatch(/width:\s*100%/)
  })
})

describe("Fix 1 / Fix 7 -- the descriptions", () => {
  it("the topic detail description is exactly 開播前固定發送通知 (the old sentence is replaced, not extended), with en / ja equivalents", async () => {
    renderSettings(1024, "zh-TW")

    const description = document.querySelector(".notification-detail-header__description")
    expect(description?.textContent).toBe("開播前固定發送通知")
    expect(description?.textContent).not.toContain("設定")
    expect(t("zh-TW", "notificationSettings.detailDescription")).toBe("開播前固定發送通知")
    expect(t("en", "notificationSettings.detailDescription")).toBe("A notification is always sent before the stream starts")
    expect(t("ja", "notificationSettings.detailDescription")).toBe("配信開始前に必ず通知が送られます")
  })

  it("the notification-type description (Fix 7) is unchanged: member-based wording", async () => {
    renderSettings(1024, "zh-TW")

    const panel = document.querySelector(".notification-detail-panel") as HTMLElement
    expect(panel.querySelector(".notification-detail-section__description")?.textContent).toBe("選擇要收到這個成員的直播、新片通知")
    expect(panel.querySelectorAll(".ant-segmented-item")).toHaveLength(3)
  })
})
