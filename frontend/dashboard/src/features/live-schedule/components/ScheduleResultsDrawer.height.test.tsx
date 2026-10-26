import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { SLOT_COUNT } from "../model/scheduleGrid"
import type { ScheduledStream } from "../model/scheduledStream"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { readStylesheet, rulesOf } from "../../../test/readStylesheet"

// The phone results drawer sizes itself to its content (measured, then held) and the stylesheet only caps it. jsdom has no layout, so the three
// measured pieces get sizes derived from what is actually rendered, and the sheet reports the height it was fixed to.

const HEADER = 48
const DATE_HEADING = 28
/** The sheet's own chrome in a real browser: its 1px top border, no padding (no safe-area inset on the test device). */
const CHROME = 1
let rowHeight = 52

/** A stream in `slot` (30-minute row) of 2026-09-21. */
function stream(id: string, channelId: string, slot: number): ScheduledStream {
  const start = new Date(2026, 8, 21, Math.floor(slot / 2), slot % 2 === 0 ? 0 : 30).getTime()
  return { id, channelId, videoId: `v_${id}`, title: `title ${id}`, description: "", status: "upcoming", scheduledStartMs: start, topics: [] }
}

/** Seven days from 2026-09-21; `placements[dayIndex]` = that day's streams, each in its own slot row. */
function makeWeek(placements: Record<number, { slot: number; stream: ScheduledStream }[]>): ScheduleDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
    for (const { slot, stream: placed } of placements[index] ?? []) slots[slot].push(placed)
    return { date: new Date(2026, 8, 21 + index), isToday: index === 0, slots }
  })
}

/** An Ema event in `slot`. */
const ema = (id: string, slot: number) => ({ slot, stream: stream(id, "ch_aizawa_ema", slot) })
/** A Pekora event in `slot`. */
const pekora = (id: string, slot: number) => ({ slot, stream: stream(id, "ch_usada_pekora", slot) })

// Five events on four days, two creators.
const FIVE = makeWeek({ 0: [ema("e1", 20), pekora("p1", 20)], 1: [pekora("p2", 7)], 2: [ema("e2", 43)], 4: [ema("e3", 20)] })

/** Sets the viewport width useBreakpoint and the drawer read. */
function setViewport(width: number, height = 844) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height })
}

const NOW = new Date(2026, 8, 21, 9, 10)

/** The grid on a phone with a Creator Filter applied, inside the page element the drawer publishes its reserved room on. */
function grid(days: ScheduleDay[]) {
  return (
    <div className="schedule-page">
      <ScheduleGrid locale="en" days={days} now={NOW} selectedStreamId={null} onSelectStream={vi.fn()} creatorFilterActive />
    </div>
  )
}

/** The results drawer element. */
const drawer = () => document.querySelector<HTMLElement>(".schedule-results")!
/** The room the page currently reserves for the drawer (empty when none). */
const reserved = () => document.querySelector<HTMLElement>(".schedule-page")!.style.getPropertyValue("--schedule-results-height")
/** How many result rows are rendered. */
const rowCount = () => document.querySelectorAll(".schedule-results__row").length
/** The height the sheet should be fixed to for this many rows and date groups. */
const expected = (rows: number, groups: number) => `${HEADER + rows * rowHeight + groups * DATE_HEADING + CHROME}px`

beforeEach(() => {
  rowHeight = 52
  window.localStorage.clear()
  resetAllSharedStateForTests()
  setViewport(390)
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  // jsdom reports a 16px default border on unstyled elements; the real sheet has a 1px top border (CHROME).
  const realComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) =>
    element.classList.contains("schedule-results")
      ? ({ paddingTop: "0px", paddingBottom: "0px", borderTopWidth: `${CHROME}px`, borderBottomWidth: "0px" } as unknown as CSSStyleDeclaration)
      : realComputedStyle(element, pseudo),
  )
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("schedule-results__header")) return HEADER
    if (this.classList.contains("schedule-results__content")) {
      return this.querySelectorAll(".schedule-results__row").length * rowHeight + this.querySelectorAll(".schedule-results__group").length * DATE_HEADING
    }
    if (this.classList.contains("schedule-results")) return Number.parseFloat(this.style.height) || 0
    return 0
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  setViewport(1024)
})

describe("phone results drawer: height follows its content", () => {
  it("is exactly the header, the date groups and the rows (5 events on 4 days)", () => {
    render(grid(FIVE))

    expect(drawer().style.height).toBe(expected(5, 4))
    expect(reserved()).toBe(drawer().style.height)
  })

  it("a single event needs only its own small sheet", () => {
    render(grid(makeWeek({ 0: [ema("e1", 20)] })))

    expect(drawer().style.height).toBe(expected(1, 1))
  })

  it("keeps its height through a background refresh of the same creators' events (no jump)", () => {
    const view = render(grid(FIVE))
    const before = drawer().style.height
    const refreshed = makeWeek({ 0: [ema("e1", 20), pekora("p1", 20), ema("e1b", 22)], 1: [pekora("p2", 7)], 2: [ema("e2", 43)], 4: [ema("e3", 20)] })

    view.rerender(grid(refreshed))

    expect(rowCount()).toBe(6) // the list really did change
    expect(drawer().style.height).toBe(before)
    expect(reserved()).toBe(before)
  })

  it("measures again when the creators in the results change (a new filter)", () => {
    const view = render(grid(FIVE))

    view.rerender(grid(makeWeek({ 0: [ema("e1", 20)], 2: [ema("e2", 43)] })))

    expect(drawer().style.height).toBe(expected(2, 2))
    expect(reserved()).toBe(drawer().style.height)
  })

  it("collapsing drops the fixed height and the reserved room, and reopening measures again", async () => {
    const user = userEvent.setup()
    render(grid(FIVE))
    const open = drawer().style.height

    await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
    expect(drawer().style.height).toBe("")
    expect(reserved()).toBe("")

    await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
    expect(drawer().style.height).toBe(open)
    expect(reserved()).toBe(open)
  })

  it("measures again when the viewport width changes (rows wrap differently)", () => {
    render(grid(FIVE))
    rowHeight = 70

    act(() => {
      setViewport(320)
      window.dispatchEvent(new Event("resize"))
    })

    expect(drawer().style.height).toBe(expected(5, 4))
  })

  it("does not resize for a height-only change (a phone's address bar collapsing)", () => {
    render(grid(FIVE))
    const before = drawer().style.height
    rowHeight = 70

    act(() => {
      setViewport(390, 760)
      window.dispatchEvent(new Event("resize"))
    })

    expect(drawer().style.height).toBe(before)
  })

  it("releases the reserved room when the filter is cleared", () => {
    const view = render(grid(FIVE))
    expect(reserved()).not.toBe("")

    view.rerender(
      <div className="schedule-page">
        <ScheduleGrid locale="en" days={FIVE} now={NOW} selectedStreamId={null} onSelectStream={vi.fn()} creatorFilterActive={false} />
      </div>,
    )

    expect(reserved()).toBe("")
  })

  it("keeps the header out of the scrolling list and the measured block inside it", () => {
    render(grid(FIVE))

    expect(drawer().firstElementChild).toHaveClass("schedule-results__header")
    expect(drawer().querySelector(".schedule-results__list .schedule-results__content")).not.toBeNull()
    expect(drawer().querySelector(".schedule-results__list .schedule-results__header")).toBeNull()
  })

  it("an empty result set is just the header and the message", () => {
    render(grid(makeWeek({})))

    expect(screen.getByText("No matching streams this week")).toBeInTheDocument()
    expect(drawer().style.height).toBe(expected(0, 0)) // the message has no measured height here: header + chrome only
  })
})

describe("results drawer stylesheet (schedule.css)", () => {
  let rule = ""

  beforeAll(async () => {
    const css = await readStylesheet("src/pages/schedule/styles/schedule.css")
    rule = rulesOf(css)
      .filter((candidate) => candidate.selector.split(",").some((part) => part.trim() === ".schedule-results"))
      .map((candidate) => candidate.body)
      .join("\n")
  })

  it("is capped at 85% of the visible viewport and always leaves 100px of the GRID below the top bar and the date navigator", () => {
    expect(rule).toMatch(
      /max-height:\s*min\(85dvh,\s*max\(96px,\s*calc\(100dvh - var\(--main-topbar-height, 0px\) - var\(--schedule-day-nav-height\) - 100px\)\)\)/,
    )
  })

  it("reads the date navigator height from the one token the navigator itself uses", async () => {
    const css = await readStylesheet("src/pages/schedule/styles/schedule.css")
    const navigator = rulesOf(css)
      .filter((candidate) => candidate.selector.split(",").some((part) => part.trim() === ".schedule-day-nav"))
      .map((candidate) => candidate.body)
      .join("\n")

    expect(navigator).toMatch(/height:\s*var\(--schedule-day-nav-height\)/)
    expect(css).toMatch(/--schedule-day-nav-height:\s*48px/)
  })

  it("has no fixed half-viewport height any more", () => {
    expect(rule).not.toMatch(/(^|[;\s])height:\s*50d?vh/)
  })

  it("stays full width at the bottom edge", () => {
    expect(rule).toMatch(/left:\s*0/)
    expect(rule).toMatch(/right:\s*0/)
    expect(rule).toMatch(/bottom:\s*0/)
  })
})
