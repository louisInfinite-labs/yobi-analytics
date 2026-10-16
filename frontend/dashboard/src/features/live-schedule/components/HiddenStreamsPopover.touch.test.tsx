import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { SLOT_COUNT } from "../model/scheduleGrid"
import type { ScheduledStream } from "../model/scheduledStream"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

// The Schedule "+N" control must open on ONE tap and then stay open -- on a phone, a tablet and with a mouse. A finger fires pointerenter /
// pointerleave around the tap itself (and on release); those must never open or close the list, only the tap's click opens it and only
// Escape or an outside tap/click closes it. jsdom has no layout: the viewport and the day column are driven explicitly.

const SLOT = 44
const stream = (id: string): ScheduledStream => ({ id, channelId: `ch_${id}`, videoId: `v_${id}`, title: `title ${id}`, description: "", status: "upcoming", scheduledStartMs: 0, topics: [] })
const week = (count: number): ScheduleDay[] =>
  Array.from({ length: 7 }, (_, index) => {
    const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
    if (index === 0) slots[SLOT] = Array.from({ length: count }, (_, i) => stream(`s${i + 1}`))
    return { date: new Date(2026, 8, 21 + index), isToday: index === 0, slots }
  })

let columnWidth = 312
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const DEVICES = [
  { name: "iPhone (touch, 390px)", viewport: 390, column: 312, pointerType: "touch" },
  { name: "Android phone (touch, 412px)", viewport: 412, column: 330, pointerType: "touch" },
  { name: "iPad portrait (touch, 820px)", viewport: 820, column: 110, pointerType: "touch" },
  { name: "iPad landscape / Android tablet (touch, 1180px)", viewport: 1180, column: 150, pointerType: "touch" },
  { name: "tablet with a stylus (pen, 820px)", viewport: 820, column: 110, pointerType: "pen" },
] as const

function renderGrid(viewport: number, column: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport })
  columnWidth = column
  const onSelectStream = vi.fn()
  render(<ScheduleGrid locale="en" days={week(9)} now={new Date(2026, 8, 21, 22, 10)} selectedStreamId={null} onSelectStream={onSelectStream} />)
  return { onSelectStream }
}

const chip = () => document.querySelector<HTMLButtonElement>(".more-streams")!
const panel = () => document.querySelector<HTMLElement>(".hidden-streams-popover")
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

/** One finger tap: the browser's own event order -- enter, down, up, leave -- then the click, `clickDelayMs` after the finger lifted. */
function tap(target: Element, pointerType: string, clickDelayMs = 0) {
  fireEvent.pointerEnter(target, { pointerType })
  fireEvent.pointerDown(target, { pointerType })
  fireEvent.pointerUp(target, { pointerType })
  fireEvent.pointerLeave(target, { pointerType })
  if (clickDelayMs > 0) advance(clickDelayMs)
  fireEvent.click(target, { detail: 1 })
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  resetAllSharedStateForTests()
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("day-timeline") ? columnWidth : 0
  })
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 })
})

describe.each(DEVICES)("+N dialog -- $name", ({ viewport, column, pointerType }) => {
  it("has a +N control for a slot with more streams than fit", () => {
    renderGrid(viewport, column)
    expect(chip()).toBeInTheDocument()
  })

  it("ONE tap opens the dialog and it stays open after the finger is released (immediate click)", () => {
    renderGrid(viewport, column)

    tap(chip(), pointerType)

    expect(panel()).toBeInTheDocument()
    expect(chip()).toHaveAttribute("aria-expanded", "true")
    advance(10_000)
    expect(panel()).toBeInTheDocument()
  })

  it("stays open when the click arrives late (after the old 160ms close delay would have fired)", () => {
    renderGrid(viewport, column)

    tap(chip(), pointerType, 400)
    advance(10_000)

    expect(panel()).toBeInTheDocument()
  })

  it("the touch events alone never open or close anything -- only the tap's click opens it", () => {
    renderGrid(viewport, column)

    fireEvent.pointerEnter(chip(), { pointerType })
    fireEvent.pointerDown(chip(), { pointerType })
    fireEvent.pointerUp(chip(), { pointerType })
    fireEvent.pointerLeave(chip(), { pointerType })
    advance(1_000)
    expect(panel()).toBeNull()

    fireEvent.click(chip(), { detail: 1 })
    expect(panel()).toBeInTheDocument()
  })

  it("a second tap on +N keeps it open, and a tap inside the dialog (even a blur with no new focus) does not close it", () => {
    renderGrid(viewport, column)
    tap(chip(), pointerType)

    tap(chip(), pointerType, 50)
    expect(panel()).toBeInTheDocument()

    fireEvent.pointerDown(panel()!, { pointerType })
    fireEvent.blur(chip(), { relatedTarget: null })
    fireEvent.blur(panel()!, { relatedTarget: null })
    advance(10_000)
    expect(panel()).toBeInTheDocument()
  })

  it("a tap outside closes it, and the next tap on +N opens it again", () => {
    renderGrid(viewport, column)
    tap(chip(), pointerType)
    expect(panel()).toBeInTheDocument()

    fireEvent.pointerDown(document.body, { pointerType })
    expect(panel()).toBeNull()

    tap(chip(), pointerType)
    expect(panel()).toBeInTheDocument()
  })

  it("tapping a hidden stream's row opens that stream's preview (once) and closes the list", () => {
    const { onSelectStream } = renderGrid(viewport, column)
    tap(chip(), pointerType)

    const row = panel()!.querySelector<HTMLButtonElement>(".hidden-streams-popover__item")!
    fireEvent.pointerDown(row, { pointerType })
    fireEvent.click(row, { detail: 1 })

    expect(onSelectStream).toHaveBeenCalledTimes(1)
    expect(panel()).toBeNull()
  })

  it("Escape closes it", () => {
    renderGrid(viewport, column)
    tap(chip(), pointerType)

    fireEvent.keyDown(document, { key: "Escape" })

    expect(panel()).toBeNull()
  })
})

describe("+N dialog -- desktop mouse (1280px)", () => {
  const mouse = "mouse"

  it("hover opens it, a click keeps it open, and leaving the control and the dialog closes it after the grace delay", () => {
    renderGrid(1280, 150)

    fireEvent.pointerEnter(chip(), { pointerType: mouse })
    expect(panel()).toBeInTheDocument()
    fireEvent.pointerDown(chip(), { pointerType: mouse })
    fireEvent.click(chip(), { detail: 1 })
    expect(panel()).toBeInTheDocument()

    fireEvent.pointerLeave(chip(), { pointerType: mouse })
    fireEvent.pointerEnter(panel()!, { pointerType: mouse }) // crossing the gap into the dialog
    advance(500)
    expect(panel()).toBeInTheDocument()

    fireEvent.pointerLeave(panel()!, { pointerType: mouse })
    advance(200)
    expect(panel()).toBeNull()
  })

  it("a mouse click on +N (no hover first, e.g. a trackpad tap) opens it and leaving then closes it", () => {
    renderGrid(1280, 150)

    fireEvent.pointerDown(chip(), { pointerType: mouse })
    fireEvent.click(chip(), { detail: 1 })
    expect(panel()).toBeInTheDocument()

    fireEvent.pointerLeave(chip(), { pointerType: mouse })
    advance(200)
    expect(panel()).toBeNull()
  })

  it("keyboard: focusing +N opens it and tabbing away closes it", () => {
    renderGrid(1280, 150)

    act(() => chip().focus())
    expect(panel()).toBeInTheDocument()

    fireEvent.keyDown(document, { key: "Tab" })
    fireEvent.blur(chip(), { relatedTarget: document.body })
    advance(200)
    expect(panel()).toBeNull()
  })

  it("an event with no pointerType at all is treated as a mouse (hover still works)", () => {
    renderGrid(1280, 150)

    fireEvent.pointerEnter(chip())
    expect(panel()).toBeInTheDocument()
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
  })
})
