import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NewVideoDeliveryTimes } from "./NewVideoDeliveryTimes"
import { reportNotificationSaveFailed } from "../hooks/notificationSaveStatus"
import * as notificationPreferenceApi from "../api/notificationPreferenceApi"
import * as pushNotifications from "../push/pushNotifications"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { t, type Locale } from "../../../shared/i18n/translations"

vi.mock("../api/notificationPreferenceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/notificationPreferenceApi")>()),
  saveNotificationPreference: vi.fn(),
}))
vi.mock("../push/pushNotifications", () => ({ getPushSubscriptionStatus: vi.fn() }))

const save = vi.mocked(notificationPreferenceApi.saveNotificationPreference)
const STORAGE_KEY = "yobi.notificationDeliverySlots"

beforeEach(() => {
  save.mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
  window.localStorage.setItem("yobi.locale", "en")
  window.localStorage.removeItem("yobi.timeFormat")
  resetAllSharedStateForTests()
})

function seed(slots: string[], timeFormat?: "12h" | "24h") {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slots))
  if (timeFormat) window.localStorage.setItem("yobi.timeFormat", timeFormat)
  resetAllSharedStateForTests()
}

const timeSelects = () => screen.getAllByRole("combobox") as HTMLSelectElement[]
const addButton = () => screen.queryByRole("button", { name: "Add a notification time" })

describe("NewVideoDeliveryTimes", () => {
  it("shows the section title and exactly two dropdowns (08:00 and 18:00) plus one + box -- no 48-button grid, no empty placeholders", () => {
    render(<NewVideoDeliveryTimes />)

    expect(screen.getByRole("heading", { name: "New Video notification times" })).toBeInTheDocument()
    expect(timeSelects().map((select) => select.value)).toEqual(["08:00", "18:00"])
    expect(addButton()).toBeInTheDocument()
    // Every button on the page is the + box: no slot grid, and no remove x for a row that does not exist.
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Delete notification time 08:00", "Delete notification time 18:00", "Add a notification time"])
  })

  it.each<[Locale, string]>([
    ["zh-TW", "新片通知時段"],
    ["ja", "新着動画の通知時間"],
    ["en", "New Video notification times"],
  ])("is titled %s with its own wording, never a Japan-time note", (locale, title) => {
    window.localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    render(<NewVideoDeliveryTimes />)

    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument()
    expect(t(locale, "notificationSettings.deliveryTimes.title")).toBe(title)
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(/JST|Asia\/Tokyo|日本時間|日本時刻|日本標準時/)
  })

  it("lists the 48 half-hour times only inside each dropdown (00:00, 00:30 ... 23:30)", () => {
    render(<NewVideoDeliveryTimes />)

    const options = within(timeSelects()[0]).getAllByRole("option").map((option) => option.textContent)
    expect(options).toHaveLength(48)
    expect(options.slice(0, 3)).toEqual(["00:00", "00:30", "01:00"])
    expect(options[47]).toBe("23:30")
  })

  it("adds a third dropdown with the + box, backend-first, sending canonical 24-hour times", async () => {
    const user = userEvent.setup()
    render(<NewVideoDeliveryTimes />)

    await user.click(addButton()!)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][3]).toEqual(["08:00", "12:00", "18:00"])
    expect(await screen.findAllByRole("combobox")).toHaveLength(3)
    expect(timeSelects().map((select) => select.value)).toEqual(["08:00", "12:00", "18:00"])
  })

  it("hides the + box after the 4th time and shows it again when a 3rd or 4th time is removed", async () => {
    const user = userEvent.setup()
    seed(["08:00", "12:00", "18:00"])
    render(<NewVideoDeliveryTimes />)

    await user.click(addButton()!)
    expect(await screen.findAllByRole("combobox")).toHaveLength(4)
    expect(addButton()).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete notification time 21:00" }))
    expect(await screen.findAllByRole("combobox")).toHaveLength(3)
    expect(addButton()).toBeInTheDocument()
  })

  it("never offers a time another row already uses (duplicates cannot be chosen)", () => {
    render(<NewVideoDeliveryTimes />)

    const [first, second] = timeSelects()
    expect(within(first).getByRole("option", { name: "18:00" })).toBeDisabled() // the other row's time
    expect(within(first).getByRole("option", { name: "08:00" })).toBeEnabled() // its own time stays selectable
    expect(within(second).getByRole("option", { name: "08:00" })).toBeDisabled()
    expect(within(first).getByRole("option", { name: "12:30" })).toBeEnabled()
  })

  it("changes one time through its dropdown and sends the whole proposed selection", async () => {
    const user = userEvent.setup()
    render(<NewVideoDeliveryTimes />)

    await user.selectOptions(timeSelects()[0], "07:30")

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][3]).toEqual(["07:30", "18:00"])
    expect(await screen.findByDisplayValue("07:30")).toBeInTheDocument()
  })

  it("removes a time with its x control, but the last remaining time has none", async () => {
    const user = userEvent.setup()
    render(<NewVideoDeliveryTimes />)

    await user.click(screen.getByRole("button", { name: "Delete notification time 08:00" }))

    expect(await screen.findAllByRole("combobox")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: /^Delete notification time / })).not.toBeInTheDocument()
  })

  it("is capped at four times: a stored over-long selection shows the earliest four and no + box", () => {
    seed(["23:30", "01:00", "05:00", "03:00", "02:00", "04:00"])
    render(<NewVideoDeliveryTimes />)

    expect(timeSelects().map((select) => select.value)).toEqual(["01:00", "02:00", "03:00", "04:00"])
    expect(addButton()).not.toBeInTheDocument()
  })

  describe("display format (Display Settings 12h / 24h)", () => {
    it("shows 24-hour times as 08:00 and 18:00", () => {
      seed(["08:00", "18:00"], "24h")
      render(<NewVideoDeliveryTimes />)

      expect(screen.getByRole("combobox", { name: "Notification time 1" })).toHaveDisplayValue("08:00")
      expect(screen.getByRole("combobox", { name: "Notification time 2" })).toHaveDisplayValue("18:00")
    })

    it("shows 12-hour times as 8:00 AM and 6:00 PM while the stored values stay canonical 24-hour strings", async () => {
      const user = userEvent.setup()
      seed(["08:00", "18:00"], "12h")
      render(<NewVideoDeliveryTimes />)

      const [first, second] = timeSelects()
      expect(first).toHaveDisplayValue("8:00 AM")
      expect(second).toHaveDisplayValue("6:00 PM")
      expect(first.value).toBe("08:00") // DISPLAY ONLY: the option value is the canonical local time
      expect(second.value).toBe("18:00")
      expect(within(first).getAllByRole("option").map((option) => option.textContent).slice(0, 3)).toEqual(["12:00 AM", "12:30 AM", "1:00 AM"])

      await user.selectOptions(first, "09:30")
      expect(save.mock.calls[0][3]).toEqual(["09:30", "18:00"]) // never "9:30 AM"
      expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(["09:30", "18:00"])
    })
  })

  it("shows an inline alert only when this section's own change failed", async () => {
    const user = userEvent.setup()
    save.mockRejectedValueOnce(new Error("HTTP 500"))
    render(<NewVideoDeliveryTimes />)

    reportNotificationSaveFailed() // another part of the page failed: not this section's problem
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()

    await user.click(addButton()!)
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "notificationSettings.saveFailed"))
    expect(timeSelects().map((select) => select.value)).toEqual(["08:00", "18:00"]) // unchanged
  })
})
