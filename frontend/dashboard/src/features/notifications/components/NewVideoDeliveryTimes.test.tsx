import { act, render, screen, within } from "@testing-library/react"
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
  resetAllSharedStateForTests()
})

function seed(slots: string[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slots))
  resetAllSharedStateForTests()
}

const grid = () => screen.getByRole("group", { name: "Delivery time slots (every 30 minutes)" })
const slotButton = (time: string) => within(grid()).getByRole("button", { name: time })

describe("NewVideoDeliveryTimes", () => {
  it("renders the title, the fixed JST note, the 48 slots and the default selection as sorted chips with a counter", () => {
    render(<NewVideoDeliveryTimes />)

    expect(screen.getByRole("heading", { name: "New video delivery times" })).toBeInTheDocument()
    expect(screen.getByText(/JST/)).toBeInTheDocument()
    expect(screen.getByText(/Asia\/Tokyo/)).toBeInTheDocument()
    expect(within(grid()).getAllByRole("button")).toHaveLength(48)
    expect(within(screen.getByRole("list", { name: "Selected delivery times" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["08:00", "18:00"])
    expect(screen.getByRole("button", { name: "Remove 08:00" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Remove 18:00" })).toBeEnabled()
    expect(screen.getByText("2 / 4 selected")).toBeInTheDocument()
    expect(slotButton("08:00")).toHaveAttribute("aria-pressed", "true")
    expect(slotButton("18:00")).toHaveAttribute("aria-pressed", "true")
    expect(slotButton("12:30")).toHaveAttribute("aria-pressed", "false")
  })

  it("adds a slot backend-first, then shows it as a chip and updates the counter", async () => {
    const user = userEvent.setup()
    render(<NewVideoDeliveryTimes />)

    await user.click(slotButton("12:30"))

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][3]).toEqual(["08:00", "12:30", "18:00"])
    expect(await screen.findByText("3 / 4 selected")).toBeInTheDocument()
    expect(slotButton("12:30")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Remove 12:30" })).toBeInTheDocument()
  })

  it("removes a slot with its x control", async () => {
    const user = userEvent.setup()
    render(<NewVideoDeliveryTimes />)

    await user.click(screen.getByRole("button", { name: "Remove 08:00" }))

    expect(await screen.findByText("1 / 4 selected")).toBeInTheDocument()
    expect(slotButton("08:00")).toHaveAttribute("aria-pressed", "false")
  })

  it("at 4 selected disables every unselected slot and explains why; selected ones stay removable", () => {
    seed(["01:00", "02:00", "03:00", "04:00"])
    render(<NewVideoDeliveryTimes />)

    expect(screen.getByText("4 / 4 selected")).toBeInTheDocument()
    expect(slotButton("05:00")).toBeDisabled()
    expect(slotButton("23:30")).toBeDisabled()
    expect(slotButton("01:00")).toBeEnabled()
    expect(screen.getByRole("button", { name: "Remove 01:00" })).toBeEnabled()
    expect(screen.getByRole("note")).toHaveTextContent("You can choose up to 4 times. Remove one first to pick another.")
  })

  it("protects the only remaining slot: its button and x are disabled, with a hint", () => {
    seed(["08:00"])
    render(<NewVideoDeliveryTimes />)

    expect(screen.getByText("1 / 4 selected")).toBeInTheDocument()
    expect(slotButton("08:00")).toBeDisabled()
    expect(slotButton("08:00")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Remove 08:00" })).toBeDisabled()
    expect(slotButton("08:30")).toBeEnabled()
    expect(screen.getByRole("note")).toHaveTextContent("At least one time is required.")
  })

  it("shows no hint with 2 or 3 selected", () => {
    render(<NewVideoDeliveryTimes />)
    expect(screen.queryByRole("note")).not.toBeInTheDocument()
  })

  it("a rejected save keeps the selection and shows the existing inline save-failed alert", async () => {
    const user = userEvent.setup()
    save.mockRejectedValueOnce(Object.assign(new Error("HTTP 400"), { status: 400 }))
    render(<NewVideoDeliveryTimes />)

    await user.click(slotButton("12:30"))

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't save to the server/)
    expect(screen.getByText("2 / 4 selected")).toBeInTheDocument()
    expect(slotButton("12:30")).toHaveAttribute("aria-pressed", "false")
  })

  it("does not show a save failure raised by another part of the page", () => {
    render(<NewVideoDeliveryTimes />)
    act(() => reportNotificationSaveFailed())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("the alert goes away after the next successful change", async () => {
    const user = userEvent.setup()
    save.mockRejectedValueOnce(new Error("HTTP 500"))
    render(<NewVideoDeliveryTimes />)
    await user.click(slotButton("12:30"))
    await screen.findByRole("alert")

    await user.click(slotButton("12:30"))

    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(slotButton("12:30")).toHaveAttribute("aria-pressed", "true")
  })

  it.each<[Locale, string, string, string]>([
    ["zh-TW", "新影片通知時段", "已選 2 / 4", "移除 08:00"],
    ["en", "New video delivery times", "2 / 4 selected", "Remove 08:00"],
    ["ja", "新着動画の通知時刻", "2 / 4 件選択中", "08:00 を削除"],
  ])("renders every string in %s without a missing key", (locale, title, counter, remove) => {
    window.localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    const { container } = render(<NewVideoDeliveryTimes />)

    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument()
    expect(screen.getByText(counter)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: remove })).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/notificationSettings\.deliveryTimes/)
    expect(container.textContent).not.toMatch(/\{\{/)
    expect(screen.getByRole("group", { name: t(locale, "notificationSettings.deliveryTimes.gridAriaLabel") })).toBeInTheDocument()
  })
})
