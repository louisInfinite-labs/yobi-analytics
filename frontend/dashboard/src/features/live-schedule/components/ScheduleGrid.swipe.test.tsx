/** Horizontal day swiping on the phone Schedule: direction, threshold, vertical-gesture rejection, boundaries, no accidental stream open,
 * controls that keep their own interaction, the date-key selection and the accessible announcement. jsdom has no layout or real touch, so
 * gestures are driven as the pointer events a touch screen produces; the `touch-action` half (the browser keeping the vertical page scroll)
 * is pinned against the real stylesheet. */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { SLOT_COUNT } from "../model/scheduleGrid"
import { SWIPE_DOMINANCE_RATIO, SWIPE_MIN_DISTANCE_PX } from "../hooks/useDaySwipe"
import type { ScheduledStream } from "../model/scheduledStream"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { mediaBlocks, outsideMedia, readStylesheet, ruleBody } from "../../../test/readStylesheet"

const TODAY = new Date(2026, 8, 21) // a Monday
const SLOT = 44
const dateOf = (offset: number) => new Date(2026, 8, 21 + offset).toDateString()

function stream(id: string): ScheduledStream {
  return { id, channelId: `ch_${id}`, videoId: `v_${id}`, title: `title ${id}`, description: "", status: "upcoming", scheduledStartMs: 0, topics: [] }
}

function makeWeek(bySlot: Record<number, ScheduledStream[]> = {}, startOffset = 0): ScheduleDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
    slots[SLOT] = bySlot[index] ?? []
    const date = new Date(2026, 8, 21 + startOffset + index)
    return { date, isToday: date.toDateString() === TODAY.toDateString(), slots }
  })
}

let columnWidth = 312

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
}

function renderGrid(days: ScheduleDay[], { viewport = 390, column = 312, onSelectStream = vi.fn() } = {}) {
  setViewport(viewport)
  columnWidth = column
  const ui = (list: ScheduleDay[]) => <ScheduleGrid locale="en" days={list} now={new Date(2026, 8, 21, 22, 10)} selectedStreamId={null} onSelectStream={onSelectStream} />
  const view = render(ui(days))
  return { ...view, onSelectStream, rerenderDays: (list: ScheduleDay[]) => view.rerender(ui(list)) }
}

const grid = () => document.querySelector<HTMLElement>(".schedule-grid")!
const label = () => document.querySelector<HTMLElement>(".schedule-day-nav__label")!
const shownDate = () => label().dataset.date
const dayColumns = () => document.querySelectorAll(".day-column")

interface Drag {
  from?: [number, number]
  to: [number, number]
  pointerType?: string
  target?: Element
  pointerId?: number
}

/** The pointer events one finger produces: down, a few moves, up. */
function drag({ from = [200, 300], to, pointerType = "touch", target = grid(), pointerId = 1 }: Drag) {
  const at = (x: number, y: number) => ({ pointerId, pointerType, isPrimary: true, clientX: x, clientY: y })
  fireEvent.pointerDown(target, at(...from))
  fireEvent.pointerMove(target, at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2))
  fireEvent.pointerMove(target, at(...to))
  fireEvent.pointerUp(target, at(...to))
}

let nowMs = 1_000
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  resetAllSharedStateForTests()
  nowMs = 1_000
  vi.spyOn(performance, "now").mockImplementation(() => nowMs)
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("day-timeline") ? columnWidth : 0
  })
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  fetchSpy = vi.fn()
  vi.stubGlobal("fetch", fetchSpy)
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setViewport(1024)
})

describe("direction", () => {
  it("swiping LEFT moves to the NEXT day and swiping RIGHT to the PREVIOUS day", () => {
    renderGrid(makeWeek())
    expect(shownDate()).toBe(dateOf(0))

    drag({ to: [60, 300] }) // finger moves left
    expect(shownDate()).toBe(dateOf(1))
    drag({ to: [60, 300] })
    expect(shownDate()).toBe(dateOf(2))

    drag({ from: [60, 300], to: [200, 300] }) // finger moves right
    expect(shownDate()).toBe(dateOf(1))
  })

  it("shows the swiped-to day's own streams in the single day column", () => {
    renderGrid(makeWeek({ 0: [stream("mon")], 1: [stream("tue")] }))

    drag({ to: [60, 300] })

    expect(dayColumns()).toHaveLength(1)
    expect(screen.getByRole("button", { name: "title tue" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "title mon" })).toBeNull()
  })

  it("works with a pen as well as a finger", () => {
    renderGrid(makeWeek())

    drag({ to: [60, 300], pointerType: "pen" })

    expect(shownDate()).toBe(dateOf(1))
  })

  it("the < and > buttons keep working alongside it", async () => {
    renderGrid(makeWeek())

    await userEvent.setup().click(screen.getByRole("button", { name: "Next day" }))
    drag({ to: [60, 300] })
    await userEvent.setup().click(screen.getByRole("button", { name: "Previous day" }))

    expect(shownDate()).toBe(dateOf(1))
  })
})

describe("a deliberate horizontal intent is required", () => {
  it(`a sideways move shorter than ${SWIPE_MIN_DISTANCE_PX}px (a tap or wobble) changes nothing`, () => {
    renderGrid(makeWeek())

    drag({ to: [200 - (SWIPE_MIN_DISTANCE_PX - 1), 300] })
    drag({ to: [200 + (SWIPE_MIN_DISTANCE_PX - 1), 300] })

    expect(shownDate()).toBe(dateOf(0))
  })

  it("exactly the minimum distance is enough", () => {
    renderGrid(makeWeek())

    drag({ to: [200 - SWIPE_MIN_DISTANCE_PX, 300] })

    expect(shownDate()).toBe(dateOf(1))
  })

  it("a mostly vertical drag (the page scrolling) never changes the day, however far sideways it also drifted", () => {
    renderGrid(makeWeek())

    drag({ to: [150, 520] }) // 50 across, 220 down
    drag({ to: [120, 80] }) // 80 across, 220 up

    expect(shownDate()).toBe(dateOf(0))
  })

  it(`a diagonal drag must be at least ${SWIPE_DOMINANCE_RATIO}x wider than tall`, () => {
    renderGrid(makeWeek())

    drag({ to: [200 - 100, 300 + 90] }) // 100 across, 90 down: ratio 1.1
    expect(shownDate()).toBe(dateOf(0))

    drag({ to: [200 - 120, 300 + 60] }) // 120 across, 60 down: ratio 2
    expect(shownDate()).toBe(dateOf(1))
  })

  it("a gesture that starts vertical is abandoned for good, even if it ends up wide", () => {
    renderGrid(makeWeek())
    const at = (x: number, y: number) => ({ pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y })

    fireEvent.pointerDown(grid(), at(200, 300))
    fireEvent.pointerMove(grid(), at(204, 340)) // locks vertical
    fireEvent.pointerMove(grid(), at(40, 345))
    fireEvent.pointerUp(grid(), at(40, 345))

    expect(shownDate()).toBe(dateOf(0))
  })

  it("a gesture the browser cancels (it took over to scroll) changes nothing", () => {
    renderGrid(makeWeek())
    const at = (x: number, y: number) => ({ pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y })

    fireEvent.pointerDown(grid(), at(200, 300))
    fireEvent.pointerMove(grid(), at(100, 305))
    fireEvent.pointerCancel(grid(), at(100, 305))
    fireEvent.pointerUp(grid(), at(40, 305))

    expect(shownDate()).toBe(dateOf(0))
  })

  it("a second finger (a pinch) abandons the swipe", () => {
    renderGrid(makeWeek())
    const at = (id: number, x: number) => ({ pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: 300 })

    fireEvent.pointerDown(grid(), at(1, 200))
    fireEvent.pointerDown(grid(), at(2, 220))
    fireEvent.pointerMove(grid(), at(1, 60))
    fireEvent.pointerUp(grid(), at(1, 60))
    fireEvent.pointerUp(grid(), at(2, 80))

    expect(shownDate()).toBe(dateOf(0))
  })

  it("a mouse drag never changes the day (touch and pen only)", () => {
    renderGrid(makeWeek())

    drag({ to: [20, 300], pointerType: "mouse" })

    expect(shownDate()).toBe(dateOf(0))
  })
})

describe("boundaries: no wrap-around", () => {
  it("swiping right on the first loaded day stays on it", () => {
    renderGrid(makeWeek())

    drag({ from: [60, 300], to: [250, 300] })

    expect(shownDate()).toBe(dateOf(0))
  })

  it("swiping left on the last loaded day stays on it", () => {
    renderGrid(makeWeek())
    for (let step = 0; step < 6; step += 1) drag({ to: [60, 300] })
    expect(shownDate()).toBe(dateOf(6))

    drag({ to: [60, 300] })

    expect(shownDate()).toBe(dateOf(6))
  })

  it("a single loaded day has nothing to swipe to", () => {
    renderGrid(makeWeek().slice(0, 1))

    drag({ to: [60, 300] })
    drag({ from: [60, 300], to: [250, 300] })

    expect(shownDate()).toBe(dateOf(0))
  })
})

describe("a swipe never opens a stream", () => {
  it("a swipe that starts over a stream card changes the day and swallows the click the browser still sends", () => {
    const { onSelectStream } = renderGrid(makeWeek({ 0: [stream("mon")] }))
    const card = screen.getByRole("button", { name: "title mon" })

    drag({ to: [60, 300], target: card })
    fireEvent.click(card) // the click that follows a release on the same element

    expect(shownDate()).toBe(dateOf(1))
    expect(onSelectStream).not.toHaveBeenCalled()
  })

  it("a swipe stopped by a boundary still does not open the card under the finger", () => {
    const { onSelectStream } = renderGrid(makeWeek({ 0: [stream("mon")] }))
    const card = screen.getByRole("button", { name: "title mon" })

    drag({ from: [60, 300], to: [250, 300], target: card }) // right on the first day: nothing to move to
    fireEvent.click(card)

    expect(shownDate()).toBe(dateOf(0))
    expect(onSelectStream).not.toHaveBeenCalled()
  })

  it("a plain tap still opens the stream", () => {
    const { onSelectStream } = renderGrid(makeWeek({ 0: [stream("mon")] }))
    const card = screen.getByRole("button", { name: "title mon" })

    drag({ from: [200, 300], to: [203, 301], target: card })
    fireEvent.click(card)

    expect(onSelectStream).toHaveBeenCalledTimes(1)
    expect(onSelectStream.mock.calls[0][0]).toMatchObject({ id: "mon" })
  })

  it("the swallowed click is only the one that follows the swipe: a later tap, or a tap after the guard window, opens normally", () => {
    const { onSelectStream } = renderGrid(makeWeek({ 0: [stream("mon")], 1: [stream("tue")] }))

    drag({ to: [60, 300] })
    nowMs += 1_000 // well past the guard
    fireEvent.click(screen.getByRole("button", { name: "title tue" }))

    expect(onSelectStream).toHaveBeenCalledTimes(1)
  })
})

describe("controls that keep their own interaction", () => {
  it("a gesture that starts on the +N control or its panel does not change the day", () => {
    renderGrid(makeWeek({ 0: Array.from({ length: 8 }, (_, index) => stream(`m${index}`)) }), { column: 120 })
    const chip = document.querySelector<HTMLElement>(".more-streams")
    expect(chip).not.toBeNull()

    drag({ to: [60, 300], target: chip! })

    expect(shownDate()).toBe(dateOf(0))
  })

  it("a gesture that starts on an element marked data-swipe-ignore, or inside a dialog, does not change the day", () => {
    renderGrid(makeWeek())
    const ignored = document.createElement("div")
    ignored.setAttribute("data-swipe-ignore", "")
    grid().appendChild(ignored)
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    grid().appendChild(dialog)

    drag({ to: [60, 300], target: ignored })
    drag({ to: [60, 300], target: dialog })

    expect(shownDate()).toBe(dateOf(0))
  })

  it("the date navigator's own buttons are outside the swipe area (the grid element)", () => {
    renderGrid(makeWeek())

    expect(grid().contains(screen.getByRole("button", { name: "Next day" }))).toBe(false)
  })
})

describe("the selection and the announcement", () => {
  it("the selected day is its date, so it survives the loaded window rolling forward a day", () => {
    const { rerenderDays } = renderGrid(makeWeek())
    drag({ to: [60, 300] })
    drag({ to: [60, 300] })
    expect(shownDate()).toBe(dateOf(2))

    rerenderDays(makeWeek({}, 1)) // window now starts tomorrow: index 1 is the same date

    expect(shownDate()).toBe(dateOf(2))
  })

  it("the date label is a polite live region and changes with the swipe, so assistive technology announces the new day", () => {
    renderGrid(makeWeek())
    const before = label().textContent

    drag({ to: [60, 300] })

    expect(label()).toHaveAttribute("aria-live", "polite")
    expect(label().textContent).not.toBe(before)
    expect(label().textContent).toContain("22") // the 22nd, Tuesday
  })

  it("swiping reads only the days already loaded: it never fetches", () => {
    renderGrid(makeWeek())

    drag({ to: [60, 300] })
    drag({ from: [60, 300], to: [250, 300] })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("only the phone's single-day layout swipes", () => {
  it.each([768, 1024, 1440])("at %ipx all seven days are shown and a swipe changes nothing", (width) => {
    renderGrid(makeWeek(), { viewport: width })

    drag({ to: [60, 300] })

    expect(document.querySelector(".schedule-day-nav")).toBeNull()
    expect(dayColumns()).toHaveLength(7)
  })

  it("crossing into the phone width enables it", () => {
    renderGrid(makeWeek(), { viewport: 767 })

    drag({ to: [60, 300] })

    expect(shownDate()).toBe(dateOf(1))
  })
})

describe("the browser keeps the vertical scroll (touch-action)", () => {
  it("the phone grid is pan-y pinch-zoom: vertical scrolling and pinch stay native, horizontal moves reach the swipe handler", async () => {
    const css = await readStylesheet("src/pages/schedule/styles/schedule.css")

    expect(ruleBody(mediaBlocks(css, "(max-width: 767px)"), ".schedule-grid")).toMatch(/touch-action:\s*pan-y pinch-zoom\s*;/)
    expect(outsideMedia(css)).not.toMatch(/\.schedule-grid\s*\{[^}]*touch-action/) // tablet and desktop are untouched
  })
})
