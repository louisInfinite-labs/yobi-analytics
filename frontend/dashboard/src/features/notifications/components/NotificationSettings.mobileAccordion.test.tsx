import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

const originalWidth = window.innerWidth

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width })
}

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue([{ id: "apex", labels: { en: "Apex", "zh-TW": "Apex", ja: "Apex" } }])
  window.localStorage.setItem("yobi.locale", "en")
  window.localStorage.removeItem("yobi.timeFormat")
  window.localStorage.removeItem("yobi.notificationDeliverySlots")
  resetAllSharedStateForTests()
})

afterEach(() => setViewportWidth(originalWidth))

function renderPage() {
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

const row = (name: RegExp) => screen.getByRole("button", { name })
/** The topic rows in list order: the 全部 row first, then the four default topic cards (Apex among them). */
const topicRows = () => [...document.querySelectorAll<HTMLElement>(".notification-topic-item")]
const otherRow = () => topicRows().find((item) => !/^(All|Apex)/.test(item.textContent ?? ""))!
const panels = () => [...document.querySelectorAll<HTMLElement>(".notification-detail-panel")]
const openRows = () => screen.queryAllByRole("button", { expanded: true })

describe("Notification Settings on a phone: the topic list is an accordion", () => {
  beforeEach(() => setViewportWidth(390))

  it("starts with every topic collapsed and no detail panel on the page, each row showing a collapsed chevron state", () => {
    renderPage()

    expect(panels()).toHaveLength(0)
    expect(topicRows().length).toBeGreaterThanOrEqual(2)
    expect(document.querySelectorAll(".notification-topic-item__chevron")).toHaveLength(topicRows().length)
    for (const item of topicRows()) expect(item).toHaveAttribute("aria-expanded", "false")
  })

  it("expands the tapped topic's detail DIRECTLY below its own row, inside the list", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()

    await user.click(row(/^Apex/))

    const apex = row(/^Apex/)
    expect(apex).toHaveAttribute("aria-expanded", "true")
    expect(apex.classList.contains("is-expanded")).toBe(true)
    const accordion = apex.closest(".notification-topic-accordion") as HTMLElement
    expect(accordion).not.toBeNull()
    expect(apex.nextElementSibling).toBe(accordion.querySelector(".notification-topic-accordion__panel"))
    expect(apex).toHaveAttribute("aria-controls", apex.nextElementSibling!.id)
    expect(panels()).toHaveLength(1)
    expect(accordion.contains(panels()[0])).toBe(true)
  })

  it("shows the topic's own settings (type, members, New Video times) without repeating the topic's name as a big header", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()
    await user.click(row(/^All/))

    const panel = within(panels()[0])
    expect(panel.getByRole("radio", { name: "Live + New Video" })).toBeChecked()
    expect(panel.getByRole("heading", { name: "Notified members" })).toBeInTheDocument()
    expect(panel.getByRole("button", { name: /^Manage Members/ })).toBeInTheDocument()
    expect(panel.getByRole("heading", { name: "New Video notification times" })).toBeInTheDocument()
    expect(panel.queryByRole("heading", { level: 2 })).toBeNull()
  })

  it("collapses on the second tap of the same topic", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()

    await user.click(row(/^Apex/))
    await user.click(row(/^Apex/))

    expect(row(/^Apex/)).toHaveAttribute("aria-expanded", "false")
    expect(panels()).toHaveLength(0)
  })

  it("keeps exactly one topic open: tapping another closes the open one and expands the new one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()

    await user.click(row(/^Apex/))
    const other = otherRow()
    await user.click(other)

    expect(openRows()).toHaveLength(1)
    expect(other).toHaveAttribute("aria-expanded", "true")
    expect(row(/^Apex/)).toHaveAttribute("aria-expanded", "false")
    expect(panels()).toHaveLength(1)
    expect(other.nextElementSibling).toBe(document.querySelector(".notification-topic-accordion__panel"))
  })

  it("never resets a topic's settings by collapsing or switching: Apex -> change -> collapse -> reopen, and Apex -> another topic -> Apex", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()

    await user.click(row(/^Apex/))
    await user.selectOptions(within(panels()[0]).getByRole("combobox", { name: "Notification time 1" }), "07:30")
    await user.click(within(panels()[0]).getByRole("radio", { name: "Live" }))

    await user.click(row(/^Apex/)) // collapse
    await user.click(row(/^Apex/)) // reopen
    expect(within(panels()[0]).getByRole("radio", { name: "Live" })).toBeChecked()

    await user.click(otherRow())
    expect(within(panels()[0]).getByRole("radio", { name: "Live + New Video" })).toBeChecked() // the other topic's own value, untouched
    await user.click(row(/^Apex/))
    expect(within(panels()[0]).getByRole("radio", { name: "Live" })).toBeChecked()

    // The notification times are one global setting: the change survived the collapse / switch too (a Live-only topic hides the times, so
    // read them where they show).
    await user.click(otherRow())
    const times = within(panels()[0]).getAllByRole("combobox", { name: /^Notification time/ }) as HTMLSelectElement[]
    expect(times.map((select) => select.value)).toEqual(["07:30", "18:00"])
  })

  it("keeps the New Video times working inside the accordion: the 08:00 / 18:00 defaults and the + box (max 4)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()
    await user.click(row(/^All/))

    const scope = () => within(panels()[0])
    expect((scope().getAllByRole("combobox", { name: /^Notification time/ }) as HTMLSelectElement[]).map((s) => s.value)).toEqual(["08:00", "18:00"])
    await user.click(scope().getByRole("button", { name: "Add a notification time" }))
    await user.click(scope().getByRole("button", { name: "Add a notification time" }))
    expect(scope().getAllByRole("combobox", { name: /^Notification time/ })).toHaveLength(4)
    expect(scope().queryByRole("button", { name: "Add a notification time" })).toBeNull()
    expect(scope().getAllByRole("button", { name: /^Delete notification time/ })).toHaveLength(4)
  })

  it("opens the Notification Members drawer for the open topic", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()
    await user.click(row(/^Apex/))

    await user.click(within(panels()[0]).getByRole("button", { name: /^Manage Members/ }))

    expect(document.querySelector(".topic-creator-drawer")).not.toBeNull()
  })

  it("leaves Add topic as a plain button below the list (not an accordion row) that still opens the add-topic editor", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderPage()
    await user.click(row(/^Apex/))

    const add = screen.getByRole("button", { name: "Add topic" })
    expect(add.closest(".notification-topic-accordion")).toBeNull()
    expect(add).not.toHaveAttribute("aria-expanded")
    await user.click(add)

    expect(screen.queryByRole("button", { name: "Add topic" })).toBeNull() // the existing draft state: the add button steps aside
    expect(screen.getByRole("combobox", { name: "Select notification topic" })).toBeInTheDocument()
    expect(openRows()).toHaveLength(0) // the draft editor replaces the open accordion item
    await user.click(row(/^Apex/)) // tapping a saved topic abandons the draft and opens that topic
    expect(row(/^Apex/)).toHaveAttribute("aria-expanded", "true")
    expect(screen.queryByRole("combobox", { name: "Select notification topic" })).toBeNull()
  })
})

describe("Notification Settings on desktop and tablet keeps its list + detail layout", () => {
  it.each([768, 1024, 1366, 1920])("at %ipx: no accordion classes or aria-expanded, the detail panel sits beside / below the list, All is selected", (width) => {
    setViewportWidth(width)
    renderPage()

    expect(document.querySelector(".notification-topic-accordion")).toBeNull()
    expect(document.querySelector(".notification-topic-item__chevron")).toBeNull()
    expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0)
    expect(row(/^All/)).toHaveAttribute("aria-current", "true")
    const panel = document.querySelector(".notification-detail-panel")!
    expect(panel.parentElement).toBe(document.querySelector(".notification-settings-main"))
    expect(within(panel as HTMLElement).getByRole("heading", { level: 2 })).toBeInTheDocument() // the large topic header stays on desktop
  })
})
