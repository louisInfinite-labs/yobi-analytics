import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { SLOT_COUNT, dayKey } from "../model/scheduleGrid"
import type { ScheduledStream, ScheduledStreamStatus } from "../model/scheduledStream"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

// jsdom has no layout, so the two things the responsive Schedule reads from the browser are driven explicitly: the viewport width (what
// useBreakpoint reads) and the width of a day column (what decides how many avatars fit). Nothing here contacts any API: the grid is fed its
// days as props, and the test asserts it never fetches.

const TODAY = new Date(2026, 8, 21) // a Monday
const SLOT = 44 // 22:00

function stream(id: string, status: ScheduledStreamStatus = "upcoming"): ScheduledStream {
  return { id, channelId: `ch_${id}`, videoId: `v_${id}`, title: `title ${id}`, description: "", status, scheduledStartMs: 0, topics: [] }
}

/** Seven days from `TODAY`; `bySlot[dayIndex]` = the streams of that day's SLOT row. Today is index `todayIndex` (the window may start earlier). */
function makeWeek(bySlot: Record<number, ScheduledStream[]>, todayIndex = 0): ScheduleDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
    slots[SLOT] = bySlot[index] ?? []
    return { date: new Date(2026, 8, 21 + index - todayIndex), isToday: index === todayIndex, slots }
  })
}

const many = (prefix: string, count: number, firstStatus: ScheduledStreamStatus = "upcoming") =>
  Array.from({ length: count }, (_, index) => stream(`${prefix}${index + 1}`, index === 0 ? firstStatus : "upcoming"))

let columnWidth = 312
let observers: { callback: () => void; target: Element }[] = []

class FakeResizeObserver {
  private readonly callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
  }
  observe(target: Element) {
    observers.push({ callback: this.callback, target })
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((entry) => entry.callback !== this.callback)
  }
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
}

/** The browser reports a new size: the viewport (rotation / resize) and/or the day column the grid measures. */
function resizeTo({ viewport, column }: { viewport?: number; column?: number }) {
  act(() => {
    if (viewport !== undefined) {
      setViewport(viewport)
      window.dispatchEvent(new Event("resize"))
    }
    if (column !== undefined) {
      columnWidth = column
      for (const entry of [...observers]) entry.callback()
    }
  })
}

function renderGrid(days: ScheduleDay[], { viewport = 390, column = 312, onSelectStream = vi.fn() } = {}) {
  setViewport(viewport)
  columnWidth = column
  const view = render(<ScheduleGrid locale="en" days={days} now={new Date(2026, 8, 21, 22, 10)} selectedStreamId={null} onSelectStream={onSelectStream} />)
  return { ...view, onSelectStream }
}

const dayColumns = () => document.querySelectorAll(".day-column")
const nav = () => document.querySelector<HTMLElement>(".schedule-day-nav")
const shownDate = () => nav()?.querySelector<HTMLElement>(".schedule-day-nav__label")?.dataset.date
const prevButton = () => screen.getByRole("button", { name: "Previous day" })
const nextButton = () => screen.getByRole("button", { name: "Next day" })
const slotGroup = () => document.querySelector<HTMLElement>(".stream-avatar-group")
const visibleAvatarTitles = () => Array.from(slotGroup()?.querySelectorAll<HTMLElement>(".stream-avatar-button") ?? []).map((button) => button.getAttribute("aria-label"))
const chip = () => document.querySelector<HTMLButtonElement>(".more-streams")

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  resetAllSharedStateForTests()
  observers = []
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("day-timeline") ? columnWidth : 0
  })
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  fetchSpy = vi.fn()
  vi.stubGlobal("fetch", fetchSpy)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setViewport(1024)
})

describe("phone (below 768px): one day per page", () => {
  it("renders exactly ONE day column, with the date navigator above it", () => {
    renderGrid(makeWeek({}))

    expect(dayColumns()).toHaveLength(1)
    expect(document.querySelectorAll(".schedule-day-header")).toHaveLength(1)
    expect(nav()).not.toBeNull()
    expect(within(nav()!).getAllByRole("button")).toHaveLength(2) // < and >
    expect(document.querySelector(".schedule-day-nav + .schedule-grid")).not.toBeNull() // the navigator is the first row of the schedule content
  })

  it("defaults to today", () => {
    renderGrid(makeWeek({}, 0))

    expect(shownDate()).toBe(TODAY.toDateString())
    expect(nav()!.querySelector(".schedule-day-nav__label")).toHaveClass("is-today")
  })

  it("defaults to today even when the loaded range started before it", () => {
    renderGrid(makeWeek({}, 2)) // days run 09-19 .. 09-25; today (09-21) is the third

    expect(shownDate()).toBe(TODAY.toDateString())
  })

  it("'>' and '<' switch to the next / previous loaded day, showing that day's own streams", async () => {
    const user = userEvent.setup()
    renderGrid(makeWeek({ 0: [stream("mon")], 1: [stream("tue")], 2: [stream("wed")] }))
    expect(visibleAvatarTitles()).toEqual(["title mon"])

    await user.click(nextButton())
    expect(shownDate()).toBe(new Date(2026, 8, 22).toDateString())
    expect(visibleAvatarTitles()).toEqual(["title tue"])

    await user.click(nextButton())
    expect(shownDate()).toBe(new Date(2026, 8, 23).toDateString())
    expect(visibleAvatarTitles()).toEqual(["title wed"])

    await user.click(prevButton())
    expect(shownDate()).toBe(new Date(2026, 8, 22).toDateString())
    expect(dayColumns()).toHaveLength(1)
  })

  it("disables '<' on the first loaded day and '>' on the last, and never moves past either end", async () => {
    const user = userEvent.setup()
    renderGrid(makeWeek({}))
    expect(prevButton()).toBeDisabled()
    expect(nextButton()).toBeEnabled()

    for (let step = 0; step < 6; step++) await user.click(nextButton())
    expect(shownDate()).toBe(new Date(2026, 8, 27).toDateString())
    expect(nextButton()).toBeDisabled()
    expect(prevButton()).toBeEnabled()

    await user.click(nextButton()) // a disabled button does nothing
    expect(shownDate()).toBe(new Date(2026, 8, 27).toDateString())
    for (let step = 0; step < 8; step++) await user.click(prevButton())
    expect(shownDate()).toBe(TODAY.toDateString())
    expect(prevButton()).toBeDisabled()
  })

  it("switching day uses the data already loaded: it never fetches", async () => {
    const user = userEvent.setup()
    renderGrid(makeWeek({ 3: [stream("thu")] }))

    for (let step = 0; step < 3; step++) await user.click(nextButton())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(visibleAvatarTitles()).toEqual(["title thu"])
  })

  it("keeps the time-of-day layout: all 48 rows of the one day, with the same time labels", () => {
    renderGrid(makeWeek({ 0: [stream("a")] }))

    expect(document.querySelectorAll(".time-label")).toHaveLength(SLOT_COUNT)
    expect(document.querySelectorAll(".day-timeline .schedule-slot")).toHaveLength(SLOT_COUNT)
  })

  it("keeps the selected DATE when the window shifts a day (midnight), instead of jumping to another day", async () => {
    const user = userEvent.setup()
    const { rerender } = renderGrid(makeWeek({}, 0))
    await user.click(nextButton())
    await user.click(nextButton()) // 09-23
    expect(shownDate()).toBe(new Date(2026, 8, 23).toDateString())

    const tomorrow = Array.from({ length: 7 }, (_, index) => {
      const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
      return { date: new Date(2026, 8, 22 + index), isToday: index === 0, slots }
    })
    rerender(<ScheduleGrid locale="en" days={tomorrow} now={new Date(2026, 8, 22, 0, 5)} selectedStreamId={null} onSelectStream={() => {}} />)

    expect(shownDate()).toBe(new Date(2026, 8, 23).toDateString())
    expect(dayKey(new Date(2026, 8, 23))).toBe("2026-09-23")
  })
})

describe("tablet / notebook / desktop keep the existing multi-day grid", () => {
  it.each([768, 820, 1024, 1280, 1366, 1440, 1920])("%ipx: seven day columns, the day-name headers, and no date navigator", (width) => {
    renderGrid(makeWeek({}), { viewport: width, column: 150 })

    expect(dayColumns()).toHaveLength(7)
    expect(document.querySelectorAll(".schedule-day-header")).toHaveLength(7)
    expect(nav()).toBeNull()
  })

  it("rotating a phone to landscape (>= 768px) switches to the multi-day grid, and back again keeps the day that was open", async () => {
    const user = userEvent.setup()
    renderGrid(makeWeek({}), { viewport: 390 })
    await user.click(nextButton())
    expect(dayColumns()).toHaveLength(1)

    resizeTo({ viewport: 844, column: 100 })
    expect(dayColumns()).toHaveLength(7)
    expect(nav()).toBeNull()

    resizeTo({ viewport: 390, column: 312 })
    expect(dayColumns()).toHaveLength(1)
    expect(shownDate()).toBe(new Date(2026, 8, 22).toDateString())
  })
})

describe("phone: avatars beyond the slot's width collapse into +N", () => {
  it("shows only the avatars that fit and a +N with the exact hidden count, in the original order", () => {
    renderGrid(makeWeek({ 0: many("s", 9) }), { column: 312 }) // 6 avatars + the chip fit; 7 would need 315

    expect(visibleAvatarTitles()).toEqual(["title s1", "title s2", "title s3", "title s4", "title s5", "title s6"])
    expect(chip()).toHaveTextContent("+3")
    expect(chip()).toHaveAccessibleName("3 more streams")
  })

  it("shows no +N when every avatar fits (a phone column is wider than a desktop one)", () => {
    renderGrid(makeWeek({ 0: many("s", 7) }), { column: 312 })

    expect(visibleAvatarTitles()).toHaveLength(7)
    expect(chip()).toBeNull()
  })

  it("opening +N lists exactly the hidden streams (not the visible ones), and a row opens that stream", async () => {
    const user = userEvent.setup()
    const { onSelectStream } = renderGrid(makeWeek({ 0: many("s", 9) }), { column: 312 })

    await user.click(chip()!)

    const panel = await screen.findByRole("dialog", { name: "3 more streams" })
    const rows = within(panel).getAllByRole("button")
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("title s7"), expect.stringContaining("title s8"), expect.stringContaining("title s9")])

    await user.click(rows[1])
    expect(onSelectStream).toHaveBeenCalledWith(expect.objectContaining({ id: "s8" }))
  })

  it("recalculates when the column width changes (resize or rotation)", () => {
    renderGrid(makeWeek({ 0: many("s", 9) }), { column: 312 })
    expect(visibleAvatarTitles()).toHaveLength(6)
    expect(chip()).toHaveTextContent("+3")

    resizeTo({ column: 200 }) // 4 avatars + a 1-digit chip = 195
    expect(visibleAvatarTitles()).toHaveLength(4)
    expect(chip()).toHaveTextContent("+5")

    resizeTo({ column: 340 }) // a wider phone: 7 avatars + chip = 315 (all 9 would need 356)
    expect(visibleAvatarTitles()).toHaveLength(7)
    expect(chip()).toHaveTextContent("+2")

    resizeTo({ column: 520 }) // everything fits again
    expect(visibleAvatarTitles()).toHaveLength(9)
    expect(chip()).toBeNull()
  })

  it("recalculates when another day is selected (each day collapses by its own streams)", async () => {
    const user = userEvent.setup()
    renderGrid(makeWeek({ 0: many("m", 9), 1: many("t", 3), 2: many("w", 12) }), { column: 312 })
    expect(chip()).toHaveTextContent("+3")

    await user.click(nextButton())
    expect(visibleAvatarTitles()).toHaveLength(3)
    expect(chip()).toBeNull()

    await user.click(nextButton())
    expect(visibleAvatarTitles()).toHaveLength(6)
    expect(chip()).toHaveTextContent("+6")
  })

  it("never draws wider than the slot it was given", () => {
    for (const column of [120, 200, 312, 362]) {
      const { unmount } = renderGrid(makeWeek({ 0: many("s", 10) }), { column })
      const shown = visibleAvatarTitles().length
      const hidden = 10 - shown
      const chipWidth = hidden >= 10 ? 40 : 35
      expect(shown * 40 + (hidden > 0 ? chipWidth : -4), `column ${column}`).toBeLessThanOrEqual(column)
      unmount()
    }
  })

  it("keeps LIVE status on the avatar that is live, and shows a hidden live stream as live in the +N list", async () => {
    const user = userEvent.setup()
    const streams = [stream("a"), stream("b"), stream("c"), stream("d"), stream("e"), stream("f"), stream("g", "live"), stream("h")]
    renderGrid(makeWeek({ 0: [{ ...streams[0], status: "live" }, ...streams.slice(1)] }), { column: 250 }) // 5 avatars + chip

    const badges = document.querySelectorAll(".stream-avatar-live-badge")
    expect(badges).toHaveLength(1) // only the visible live one (the first) is badged; ordering is untouched
    expect(visibleAvatarTitles()?.[0]).toBe("title a")

    await user.click(chip()!)
    const panel = await screen.findByRole("dialog")
    expect(within(panel).getAllByText(/LIVE/i).length).toBeGreaterThanOrEqual(1) // the hidden "g" is live
  })
})

describe("multi-day grid: the fixed overflow rule is kept, bounded by the column", () => {
  it("a wide desktop column: 4 streams show all four, 5+ show three and +N (as before)", () => {
    renderGrid(makeWeek({ 0: many("s", 4) }), { viewport: 1440, column: 161 })
    expect(visibleAvatarTitles()).toHaveLength(4)
    expect(chip()).toBeNull()
  })

  it("more than 4 streams: 3 avatars and a +N with the rest, exactly as before", () => {
    renderGrid(makeWeek({ 0: many("s", 12) }), { viewport: 1440, column: 161 })

    expect(visibleAvatarTitles()).toHaveLength(3)
    expect(chip()).toHaveTextContent("+9")
  })

  it("a narrow tablet column cannot hold 4 avatars: only what fits is drawn, the rest is +N", () => {
    renderGrid(makeWeek({ 0: many("s", 4) }), { viewport: 768, column: 80 })

    expect(visibleAvatarTitles()).toHaveLength(1)
    expect(chip()).toHaveTextContent("+3")
  })

  it("without any measured width (no layout) the old fixed rule applies unchanged", () => {
    renderGrid(makeWeek({ 0: many("s", 6) }), { viewport: 1440, column: 0 })

    expect(visibleAvatarTitles()).toHaveLength(3)
    expect(chip()).toHaveTextContent("+3")
  })
})
