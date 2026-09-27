import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveSchedulePage } from "./LiveSchedulePage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("LiveSchedulePage", () => {
  it("renders the page title, toolbar, and one column per day of the week", () => {
    const { container } = render(<LiveSchedulePage />)

    expect(screen.getByText("Live Schedule")).toBeInTheDocument()
    expect(screen.getByText("Time")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Previous week" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next week" })).toBeInTheDocument()
    expect(container.querySelectorAll(".day-column")).toHaveLength(7)
  })

  it("renders the filter toolbar control as disabled (not wired to real behavior yet), with no manual timezone control", () => {
    render(<LiveSchedulePage />)

    expect(screen.getByText("Filter").closest("button")).toBeDisabled()
    expect(screen.queryByText("JST")).not.toBeInTheDocument()
  })
})

describe("LiveSchedulePage timetable", () => {
  beforeEach(() => {
    // Fix "now" (Wed 2026-09-23, local) so the displayed week is deterministic;
    // only Date is faked, real timers keep user-event and React scheduling working.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 8, 23, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows the Sunday-to-Saturday week containing today", () => {
    const { container } = render(<LiveSchedulePage />)

    const dayNames = Array.from(container.querySelectorAll(".day-name")).map((node) => node.textContent)
    expect(dayNames).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
    expect(container.querySelector(".week-selector__label")).toHaveTextContent("Sep 20 - Sep 26")
    expect(container.querySelectorAll(".schedule-day-header.is-today")).toHaveLength(1)
    expect(container.querySelector(".schedule-day-header.is-today .day-name")).toHaveTextContent("Wed")
  })

  it("covers the full local day: 24 hourly labels from 00:00 to 23:00 and 48 half-hour rows per day", () => {
    const { container } = render(<LiveSchedulePage />)

    const labels = Array.from(container.querySelectorAll(".time-label"))
      .map((node) => node.textContent)
      .filter(Boolean)
    expect(labels).toHaveLength(24)
    expect(labels[0]).toBe("00:00")
    expect(labels[23]).toBe("23:00")
    for (const timeline of container.querySelectorAll(".day-timeline")) {
      expect(timeline.children).toHaveLength(48)
    }
  })

  it("pages between weeks with the Previous/Next buttons", async () => {
    const user = userEvent.setup()
    const { container } = render(<LiveSchedulePage />)
    const label = () => container.querySelector(".week-selector__label")!.textContent

    await user.click(screen.getByRole("button", { name: "Next week" }))
    expect(label()).toBe("Sep 27 - Oct 3")

    await user.click(screen.getByRole("button", { name: "Previous week" }))
    await user.click(screen.getByRole("button", { name: "Previous week" }))
    expect(label()).toBe("Sep 13 - Sep 19")
  })

  it("opens the stream detail dialog from an avatar with creator, title and both actions, and closes it with Escape", async () => {
    const user = userEvent.setup()
    const { container } = render(<LiveSchedulePage />)

    await user.click(container.querySelector<HTMLElement>(".stream-avatar-button")!)

    const dialog = screen.getByRole("dialog")
    expect(dialog.querySelector(".creator-detail-name")?.textContent).toBeTruthy()
    expect(dialog.querySelector(".stream-detail-title")?.textContent).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Set Reminder" })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "Open Stream" })).toBeEnabled()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("Open Stream swaps the detail dialog for the player-only video modal, which closes on a backdrop click", async () => {
    const user = userEvent.setup()
    const { container } = render(<LiveSchedulePage />)
    await user.click(container.querySelector<HTMLElement>(".stream-avatar-button")!)

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Open Stream" }))

    expect(document.querySelector(".stream-detail-content")).toBeNull()
    const backdrop = document.querySelector<HTMLElement>(".video-player-modal__backdrop")!
    expect(backdrop.querySelector("iframe")).toBeInTheDocument()
    expect(within(backdrop).queryByRole("button")).not.toBeInTheDocument()

    await user.click(backdrop)
    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })
})
