import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

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
const DEFAULT_ORDER = ["all", "sf6", "valorant", "apex", "minecraft"]

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue([{ id: "apex", labels: { en: "Apex", "zh-TW": "Apex", ja: "Apex" } }])
  window.localStorage.setItem("yobi.locale", "en")
  window.localStorage.removeItem("yobi.timeFormat")
  window.localStorage.removeItem("yobi.notificationDeliverySlots")
  resetAllSharedStateForTests()
})

function seedAllTopicType(notificationType: "live" | "newVideo" | "both") {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ topicOrder: DEFAULT_ORDER, topics: { all: { live: [], newVideo: [], reminderOverrides: {}, notificationType } } }),
  )
  resetAllSharedStateForTests()
}

function renderPage() {
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

const detailPanel = () => document.querySelector<HTMLElement>(".notification-detail-panel")!
const timesHeading = (scope: HTMLElement | Document = document) => within(scope as HTMLElement).queryByRole("heading", { name: "New Video notification times" })

describe("New Video notification times in the topic detail card", () => {
  it("is part of the detail card, immediately after the Notification Members section -- not a separate block above the page", () => {
    renderPage()

    expect(timesHeading(detailPanel())).toBeInTheDocument()
    expect(document.querySelector(".notification-settings-content > .notification-delivery-times")).toBeNull()

    const sections = [...detailPanel().querySelectorAll(":scope > section")]
    const titles = sections.map((section) => section.querySelector("h3")?.textContent)
    const membersIndex = titles.indexOf("Notified members")
    expect(membersIndex).toBeGreaterThanOrEqual(0)
    expect(titles[membersIndex + 1]).toBe("New Video notification times")
  })

  it("shows two dropdowns (08:00 and 18:00) and a + box by default, with no JST / Japan-time wording anywhere on the page", () => {
    renderPage()

    const times = within(detailPanel()).getAllByRole("combobox", { name: /^Notification time/ }) as HTMLSelectElement[]
    expect(times.map((select) => select.value)).toEqual(["08:00", "18:00"])
    expect(within(detailPanel()).getByRole("button", { name: "Add a notification time" })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/JST|Asia\/Tokyo|日本時間|日本標準時/)
  })

  it("is one global setting: a change made on one topic's card is what every other topic's card shows", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(within(detailPanel()).getByRole("combobox", { name: "Notification time 1" }), "07:30")
    await user.click(screen.getByRole("button", { name: /^Apex/ }))

    const times = within(detailPanel()).getAllByRole("combobox", { name: /^Notification time/ }) as HTMLSelectElement[]
    expect(times.map((select) => select.value)).toEqual(["07:30", "18:00"])
  })

  it.each(["both", "newVideo"] as const)("is shown for a topic whose notification type is %s", (type) => {
    seedAllTopicType(type)
    renderPage()

    expect(timesHeading(detailPanel())).toBeInTheDocument()
  })

  it("is hidden for a topic that only sends Live notifications, and returns when New Video is switched back on", async () => {
    seedAllTopicType("live")
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()

    expect(timesHeading(detailPanel())).not.toBeInTheDocument()

    await user.click(within(detailPanel()).getByRole("radio", { name: "New Video" }))
    expect(timesHeading(detailPanel())).toBeInTheDocument()
  })
})
