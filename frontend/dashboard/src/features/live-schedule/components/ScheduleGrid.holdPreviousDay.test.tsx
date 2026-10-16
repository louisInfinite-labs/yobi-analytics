import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { SLOT_COUNT, dayKey } from "../model/scheduleGrid"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

// While an overnight stream is unresolved the loaded window starts on the previous local day (07 days: 09-20 .. 09-26, today = 09-21). The
// desktop grid shows all of them; the single-day phone layout opens on that previous day instead of today, and a day the user picks sticks.

const makeWindow = (): ScheduleDay[] =>
  Array.from({ length: 7 }, (_, index) => ({
    date: new Date(2026, 8, 20 + index),
    isToday: index === 1,
    slots: Array.from({ length: SLOT_COUNT }, () => []),
  }))

const setViewport = (width: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
const shownDate = () => document.querySelector<HTMLElement>(".schedule-day-nav__label")?.dataset.date
const renderGrid = (holdPreviousDay: boolean | undefined) =>
  render(<ScheduleGrid locale="en" days={makeWindow()} now={new Date(2026, 8, 21, 0, 30)} selectedStreamId={null} onSelectStream={vi.fn()} holdPreviousDay={holdPreviousDay} />)

beforeEach(() => {
  window.localStorage.clear()
  resetAllSharedStateForTests()
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  setViewport(1024)
})

describe("ScheduleGrid while the previous local day is held", () => {
  it("phone: opens on the previous day (the overnight stream's day), not on today", () => {
    setViewport(390)
    renderGrid(true)

    expect(shownDate()).toBe(new Date(2026, 8, 20).toDateString())
  })

  it("phone: without the hold it still opens on today", () => {
    setViewport(390)
    renderGrid(undefined)

    expect(shownDate()).toBe(new Date(2026, 8, 21).toDateString())
  })

  it("desktop / tablet: all seven loaded days are columns, today keeps its marker", () => {
    setViewport(1024)
    renderGrid(true)

    const headers = Array.from(document.querySelectorAll(".schedule-day-header"))
    expect(headers).toHaveLength(7)
    expect(headers.map((header) => header.classList.contains("is-today"))).toEqual([false, true, false, false, false, false, false])
    expect(dayKey(new Date(2026, 8, 20))).toBe("2026-09-20")
  })
})
