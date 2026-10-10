import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import * as liveReminderApi from "../api/liveReminderApi"
import * as notificationPreferenceApi from "../api/notificationPreferenceApi"
import { buildNotificationPreference } from "../api/notificationPreferenceApi"
import { getEffectiveNewVideoCreatorIds, getEffectiveShortCreatorIds } from "../hooks/useTopicNotificationPreferences"
import * as pushNotifications from "../push/pushNotifications"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn(),
  deleteCreatorReminder: vi.fn(),
}))
vi.mock("../api/notificationPreferenceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/notificationPreferenceApi")>()),
  saveNotificationPreference: vi.fn(),
}))
vi.mock("../push/pushNotifications", () => ({ getPushSubscriptionStatus: vi.fn() }))

// Opening the member drawer renders the whole creator roster, so a multi-step interaction here is slow in jsdom.
vi.setConfig({ testTimeout: 30000 })

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const LABELS: Record<string, string> = { valorant: "VALO", sf6: "SF6", apex: "Apex", minecraft: "Minecraft", singing: "Singing", mv: "MV", chatting: "Chatting", other: "Other" }
const BACKEND_TOPICS = Object.entries(LABELS).map(([id, label]) => ({ id, labels: { en: label, "zh-TW": label, ja: label } }))
const SAVE_FAILED = /Couldn't save to the server/

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue(BACKEND_TOPICS)
  vi.mocked(liveReminderApi.saveCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.deleteCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

function storedState() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
}

function renderSettings() {
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

/** "+ Add topic" -> pick Short in the dropdown -> Save: the Short card becomes the selected card. */
async function addShortCard(user: ReturnType<typeof userEvent.setup>) {
  renderSettings()
  await user.click(screen.getByRole("button", { name: "Add topic" }))
  await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
  await user.click(await screen.findByTitle("Short"))
  await user.click(screen.getByRole("button", { name: "Save" }))
}

async function openShortMembers(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(document.querySelector(".notification-detail-panel") as HTMLElement).getAllByRole("button", { name: /Manage Members/ })[0])
  await screen.findAllByRole("switch", { name: /new video notifications/ })
}

const savedCalls = () => vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls

describe("the Short card in the '+ Add topic' dropdown", () => {
  it("adding Short creates a card named Short, with no notification-type choice and no Reset", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)

    const names = [...document.querySelectorAll(".notification-topic-item__name")].map((el) => el.textContent)
    expect(names).toEqual(["All", "SF6", "VALO", "Apex", "Minecraft", "Short"])
    const detail = within(document.querySelector(".notification-detail-panel") as HTMLElement)
    expect(detail.getByRole("heading", { level: 2, name: "Short" })).toBeInTheDocument()
    expect(detail.queryByRole("radio", { name: "Live + New Video" })).not.toBeInTheDocument()
    expect(detail.queryByRole("button", { name: /Reset/ })).not.toBeInTheDocument()
    expect(detail.getByRole("button", { name: /Manage Members/ })).toBeInTheDocument()
  })

  it("is OFF by default: no Short card, and a Short card with no members, both mean no creator's Shorts notify", async () => {
    expect(getEffectiveShortCreatorIds().size).toBe(0)
    expect(Object.values(buildNotificationPreference(true, getEffectiveNewVideoCreatorIds(), getEffectiveShortCreatorIds()).newVideoShortCreatorOverride).every((on) => !on)).toBe(true)

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)

    expect(getEffectiveShortCreatorIds().size).toBe(0)
    expect(savedCalls()).toHaveLength(0)
  })

  it("the member list has only the New Video column (a Short is a video, there is no live or reminder)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)
    await openShortMembers(user)

    expect(screen.queryAllByRole("switch", { name: /live notifications/ })).toHaveLength(0)
    expect(screen.queryAllByRole("button", { name: /'s reminder time/ })).toHaveLength(0)
  })

  it("members decide Shorts: enabling creator A sends A under the separate Short field and enables no ordinary new video", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)
    await openShortMembers(user)

    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])

    await vi.waitFor(() => expect(savedCalls()).toHaveLength(1))
    const [enabled, newVideoIds, shortIds] = savedCalls()[0]
    expect(enabled).toBe(true)
    expect(newVideoIds.size).toBe(0) // a Short member never turns on that creator's ordinary new videos
    expect(shortIds.size).toBe(1)
    const body = buildNotificationPreference(enabled, newVideoIds, shortIds)
    expect(Object.values(body.newVideoCreatorOverride).every((on) => !on)).toBe(true)
    expect(Object.values(body.newVideoShortCreatorOverride).filter(Boolean)).toHaveLength(1)
    expect(Object.keys(body).filter((key) => /topic/i.test(key))).toEqual([]) // no topic field at all, so no topic = "short"
    expect(JSON.stringify(body)).not.toContain('"short"')
    expect(storedState().topics.short.newVideo).toEqual([...shortIds])
  })

  it("turning the member off clears the Short field again", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)
    await openShortMembers(user)
    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])
    await vi.waitFor(() => expect(savedCalls()).toHaveLength(1))

    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])

    await vi.waitFor(() => expect(savedCalls()).toHaveLength(2))
    expect(savedCalls()[1][2].size).toBe(0)
    expect(getEffectiveShortCreatorIds().size).toBe(0)
  })

  it("keeps the Short members after a reload", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)
    await openShortMembers(user)
    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])
    await vi.waitFor(() => expect(getEffectiveShortCreatorIds().size).toBe(1))

    resetAllSharedStateForTests() // what a page reload does to the in-memory stores

    expect(getEffectiveShortCreatorIds().size).toBe(1)
    expect([...document.querySelectorAll(".notification-topic-item__name")].map((el) => el.textContent)).toContain("Short")
  })

  it("a rejected save leaves the member OFF, shows the error and stores nothing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)
    await openShortMembers(user)
    vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockRejectedValueOnce(new Error("HTTP 403"))

    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED)
    expect(screen.getAllByRole("switch", { name: /new video notifications/ })[0]).not.toBeChecked()
    expect(storedState().topics?.short?.newVideo ?? []).toEqual([])
    expect(getEffectiveShortCreatorIds().size).toBe(0)
  })

  it("without a push subscription the member is kept locally and nothing is sent (enabling notifications sends it)", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)
    await openShortMembers(user)

    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])

    await vi.waitFor(() => expect(getEffectiveShortCreatorIds().size).toBe(1))
    expect(savedCalls()).toHaveLength(0)
  })

  it("an ordinary topic card's member never enables Shorts", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()
    await user.click(await screen.findByRole("button", { name: /^SF6/ }))
    await user.click(within(document.querySelector(".notification-detail-panel") as HTMLElement).getAllByRole("button", { name: /Manage Members/ })[0])
    await screen.findAllByRole("switch", { name: /new video notifications/ })

    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])

    await vi.waitFor(() => expect(savedCalls()).toHaveLength(1))
    const [, newVideoIds, shortIds] = savedCalls()[0]
    expect(newVideoIds.size).toBe(1)
    expect(shortIds.size).toBe(0)
  })

  it("lifecycle: add -> members -> reload -> Remove -> reload -> Short is selectable again and OFF -> re-add is clean", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await addShortCard(user)
    await openShortMembers(user)
    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])
    await vi.waitFor(() => expect(getEffectiveShortCreatorIds().size).toBe(1))
    await user.keyboard("{Escape}")

    resetAllSharedStateForTests() // reload: the card and its member are still there
    expect(getEffectiveShortCreatorIds().size).toBe(1)

    await user.click(await screen.findByRole("button", { name: /^Short/ }))
    await user.click(screen.getByRole("button", { name: /Remove "Short"/ }))

    await vi.waitFor(() => expect([...document.querySelectorAll(".notification-topic-item__name")].map((el) => el.textContent)).not.toContain("Short"))
    const lastCall = savedCalls()[savedCalls().length - 1]
    expect(lastCall[2].size).toBe(0) // the backend is told Short is OFF
    expect(getEffectiveShortCreatorIds().size).toBe(0)

    resetAllSharedStateForTests() // reload: still gone and still OFF
    expect([...document.querySelectorAll(".notification-topic-item__name")].map((el) => el.textContent)).not.toContain("Short")
    expect(getEffectiveShortCreatorIds().size).toBe(0)

    // Short is offered again in "+ Add topic"; re-adding it starts with no members
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))
    await user.click(await screen.findByTitle("Short"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await screen.findByRole("heading", { level: 2, name: "Short" })
    expect(getEffectiveShortCreatorIds().size).toBe(0)
    await openShortMembers(user)
    expect(screen.getAllByRole("switch", { name: /new video notifications/ }).every((node) => node.getAttribute("aria-checked") !== "true")).toBe(true)
  })

  it("the permanent default cards have no Remove action", async () => {
    renderSettings()

    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument()
    await userEvent.setup({ pointerEventsCheck: 0 }).click(await screen.findByRole("button", { name: /^SF6/ }))
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument()
  })

  it("drops the retired notification-only cards (GTA, 7 Days to Die, Mahjong Soul, Endfield) from a stored list", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ topicOrder: ["all", "sf6", "valorant", "apex", "minecraft", "gta", "endfield", "singing"], topics: { gta: { live: [], newVideo: ["aizawa_ema"], reminderOverrides: {} } } }),
    )
    resetAllSharedStateForTests()

    renderSettings()

    const names = [...document.querySelectorAll(".notification-topic-item__name")].map((el) => el.textContent)
    expect(names).not.toContain("gta")
    expect(names).not.toContain("endfield")
    expect(getEffectiveNewVideoCreatorIds().size).toBe(0)
  })
})
