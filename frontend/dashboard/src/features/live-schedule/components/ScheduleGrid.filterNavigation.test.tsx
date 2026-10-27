import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { SLOT_COUNT } from "../model/scheduleGrid"
import type { ScheduledStream } from "../model/scheduledStream"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

// The Creator Filter's two Schedule behaviors: the desktop grid collapses rows nobody has an event in, and the phone gets a results drawer
// that navigates the one-day layout. The grid is fed its days as props (already filtered by the page), so nothing here contacts any API.

const TODAY = new Date(2026, 8, 21)

/** A stream placed in `slot` (30-minute row) of 2026-09-21, so its own start time matches the row it sits in. */
function stream(id: string, channelId: string, slot: number, status: ScheduledStream["status"] = "upcoming"): ScheduledStream {
  const start = new Date(2026, 8, 21, Math.floor(slot / 2), slot % 2 === 0 ? 0 : 30).getTime()
  return { id, channelId, videoId: `v_${id}`, title: `title ${id}`, description: "", status, scheduledStartMs: start, topics: [] }
}

/** Seven days from `TODAY`; `placements[dayIndex]` = the streams of that day, each placed in its own `slot` row. */
function makeWeek(placements: Record<number, { slot: number; stream: ScheduledStream }[]>): ScheduleDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
    for (const { slot, stream: placed } of placements[index] ?? []) slots[slot].push(placed)
    return { date: new Date(2026, 8, 21 + index), isToday: index === 0, slots }
  })
}

// Ema: Monday 10:00 (slot 20), Wednesday 21:30 (slot 43), Friday 10:00 (slot 20). Pekora: Monday 10:00 (slot 20) and Tuesday 03:30 (slot 7).
const emaMon = stream("ema-mon", "ch_aizawa_ema", 20, "live")
const emaWed = stream("ema-wed", "ch_aizawa_ema", 43)
const emaFri = stream("ema-fri", "ch_aizawa_ema", 20)
const pekoraMon = stream("pekora-mon", "ch_usada_pekora", 20)
const pekoraTue = stream("pekora-tue", "ch_usada_pekora", 7)
const WEEK = makeWeek({
  0: [
    { slot: 20, stream: emaMon },
    { slot: 20, stream: pekoraMon },
  ],
  1: [{ slot: 7, stream: pekoraTue }],
  2: [{ slot: 43, stream: emaWed }],
  4: [{ slot: 20, stream: emaFri }],
})

/** Sets the viewport width useBreakpoint reads. */
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
}

/** Renders the grid on the shared week at `viewport` px wide, with the Creator Filter applied or not. */
function renderGrid({ viewport, creatorFilterActive, onSelectStream = vi.fn() }: { viewport: number; creatorFilterActive: boolean; onSelectStream?: (s: ScheduledStream) => void }) {
  setViewport(viewport)
  const view = render(
    <ScheduleGrid
      locale="en"
      days={WEEK}
      now={new Date(2026, 8, 21, 9, 10)}
      selectedStreamId={null}
      onSelectStream={onSelectStream}
      creatorFilterActive={creatorFilterActive}
    />,
  )
  return { ...view, onSelectStream }
}

/** Every rendered time label. */
const timeLabels = () => Array.from(document.querySelectorAll<HTMLElement>(".time-label"))
/** The date the phone date navigator currently shows. */
const shownDate = () => document.querySelector<HTMLElement>(".schedule-day-nav__label")?.dataset.date
/** The results drawer element, if mounted. */
const drawer = () => document.querySelector<HTMLElement>(".schedule-results")
/** Every rendered result row. */
const resultRows = () => Array.from(document.querySelectorAll<HTMLElement>(".schedule-results__row"))

beforeEach(() => {
  window.localStorage.clear()
  resetAllSharedStateForTests()
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  setViewport(1024)
})

describe("desktop: rows with no matching event collapse", () => {
  it("keeps all 48 rows when no Creator Filter is applied", () => {
    renderGrid({ viewport: 1366, creatorFilterActive: false })

    expect(timeLabels()).toHaveLength(SLOT_COUNT)
    expect(drawer()).toBeNull()
  })

  it("keeps only the rows that hold an event in any of the seven days, in time order, each named with its own time", () => {
    renderGrid({ viewport: 1366, creatorFilterActive: true })

    expect(timeLabels().map((label) => label.dataset.slot)).toEqual(["7", "20", "43"])
    expect(timeLabels().map((label) => label.textContent)).toEqual(["03:30", "10:00", "21:30"])
  })

  it("keeps the seven day columns aligned: every column has exactly the kept rows, and the events stay in their own day and row", () => {
    renderGrid({ viewport: 1366, creatorFilterActive: true })

    const columns = Array.from(document.querySelectorAll<HTMLElement>(".day-column"))
    expect(columns).toHaveLength(7)
    for (const column of columns) expect(column.querySelectorAll(".schedule-slot")).toHaveLength(3)

    const titlesByColumn = columns.map((column) =>
      Array.from(column.querySelectorAll(".schedule-slot")).map((slot) => Array.from(slot.querySelectorAll(".stream-avatar-button")).map((b) => b.getAttribute("aria-label"))),
    )
    expect(titlesByColumn[0]).toEqual([[], ["title ema-mon", "title pekora-mon"], []])
    expect(titlesByColumn[1]).toEqual([["title pekora-tue"], [], []])
    expect(titlesByColumn[2]).toEqual([[], [], ["title ema-wed"]])
    expect(titlesByColumn[3]).toEqual([[], [], []])
    expect(titlesByColumn[4]).toEqual([[], ["title ema-fri"], []])
  })

  it("keeps every matching creator's avatar visible and opens the existing stream handler from one", async () => {
    const user = userEvent.setup()
    const { onSelectStream } = renderGrid({ viewport: 1366, creatorFilterActive: true })

    expect(document.querySelectorAll(".stream-avatar-button")).toHaveLength(5)
    await user.click(screen.getByRole("button", { name: "title ema-wed" }))
    expect(onSelectStream).toHaveBeenCalledWith(emaWed)
  })

  it("never shows the phone results drawer", () => {
    renderGrid({ viewport: 1366, creatorFilterActive: true })

    expect(drawer()).toBeNull()
  })

  it("shows a compact empty state instead of 48 empty rows when the filter matches no event at all", () => {
    setViewport(1366)
    render(<ScheduleGrid locale="en" days={makeWeek({})} now={new Date(2026, 8, 21, 9, 10)} selectedStreamId={null} onSelectStream={vi.fn()} creatorFilterActive />)

    expect(screen.getByRole("status")).toHaveTextContent("No matching streams this week")
    expect(timeLabels()).toHaveLength(0)
    expect(document.querySelector(".schedule-grid")).toBeNull()
  })

  it("keeps the normal empty grid, with every row, when no filter is applied", () => {
    setViewport(1366)
    render(<ScheduleGrid locale="en" days={makeWeek({})} now={new Date(2026, 8, 21, 9, 10)} selectedStreamId={null} onSelectStream={vi.fn()} />)

    expect(screen.queryByRole("status")).toBeNull()
    expect(timeLabels()).toHaveLength(SLOT_COUNT)
  })

  it("brings the grid back when the filter is cleared after an empty result", () => {
    setViewport(1366)
    const props = { locale: "en" as const, now: new Date(2026, 8, 21, 9, 10), selectedStreamId: null, onSelectStream: vi.fn() }
    const view = render(<ScheduleGrid {...props} days={makeWeek({})} creatorFilterActive />)
    expect(screen.getByRole("status")).toBeInTheDocument()

    view.rerender(<ScheduleGrid {...props} days={WEEK} creatorFilterActive={false} />)
    expect(screen.queryByRole("status")).toBeNull()
    expect(timeLabels()).toHaveLength(SLOT_COUNT)
  })

  it("leaves the empty state off the phone, whose drawer carries the message", () => {
    setViewport(390)
    render(<ScheduleGrid locale="en" days={makeWeek({})} now={new Date(2026, 8, 21, 9, 10)} selectedStreamId={null} onSelectStream={vi.fn()} creatorFilterActive />)

    expect(document.querySelector(".schedule-grid-empty")).toBeNull()
    expect(timeLabels()).toHaveLength(SLOT_COUNT)
  })
})

describe("phone: results drawer", () => {
  it("keeps the existing one-day layout with every row, and no drawer while no filter is applied", () => {
    renderGrid({ viewport: 390, creatorFilterActive: false })

    expect(document.querySelectorAll(".day-column")).toHaveLength(1)
    expect(timeLabels()).toHaveLength(SLOT_COUNT)
    expect(drawer()).toBeNull()
  })

  it("opens with the filter applied, keeping the one-day layout and every time row", () => {
    renderGrid({ viewport: 390, creatorFilterActive: true })

    expect(drawer()).not.toBeNull()
    expect(screen.getByRole("button", { name: /Results \(5\)/ })).toHaveAttribute("aria-expanded", "true")
    expect(document.querySelectorAll(".day-column")).toHaveLength(1)
    expect(timeLabels()).toHaveLength(SLOT_COUNT)
  })

  it("groups events by date in chronological order, one row per event (a creator can appear on several days)", () => {
    renderGrid({ viewport: 390, creatorFilterActive: true })

    const groups = Array.from(document.querySelectorAll<HTMLElement>(".schedule-results__group"))
    expect(groups.map((group) => group.dataset.dayKey)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-25"])
    const idsByGroup = groups.map((group) => Array.from(group.querySelectorAll<HTMLElement>(".schedule-results__row")).map((row) => row.dataset.videoId))
    expect(idsByGroup).toEqual([["v_ema-mon", "v_pekora-mon"], ["v_pekora-tue"], ["v_ema-wed"], ["v_ema-fri"]])
    // Ema has three events (Mon, Wed, Fri), Pekora two (Mon, Tue): each is its own row.
    expect(resultRows().filter((row) => row.dataset.videoId?.startsWith("v_ema"))).toHaveLength(3)
    expect(resultRows().filter((row) => row.dataset.videoId?.startsWith("v_pekora"))).toHaveLength(2)
  })

  it("a row body goes to that event's date and time slot, and collapses the drawer so it cannot cover the event", async () => {
    const user = userEvent.setup()
    renderGrid({ viewport: 390, creatorFilterActive: true })
    expect(shownDate()).toBe(TODAY.toDateString())
    // What the page looked like at the moment of the slot scroll: the day already switched, the drawer already collapsed.
    const atScroll: { collapsed: boolean | undefined; date: string | undefined }[] = []
    vi.mocked(window.scrollTo).mockImplementation(() => {
      atScroll.push({ collapsed: drawer()?.classList.contains("is-collapsed"), date: shownDate() })
    })

    const row = resultRows().find((candidate) => candidate.dataset.videoId === "v_ema-wed")!
    await user.click(row.querySelector<HTMLElement>(".schedule-results__goto")!)

    expect(shownDate()).toBe(new Date(2026, 8, 23).toDateString())
    expect(drawer()).toHaveClass("is-collapsed")
    expect(document.querySelector(".schedule-results__list")).toBeNull()
    expect(atScroll).toEqual([{ collapsed: true, date: new Date(2026, 8, 23).toDateString() }])
  })

  it("choosing the same slot again scrolls again", async () => {
    const user = userEvent.setup()
    renderGrid({ viewport: 390, creatorFilterActive: true })
    const scrollsAfterMount = vi.mocked(window.scrollTo).mock.calls.length

    await user.click(resultRows().find((r) => r.dataset.videoId === "v_ema-wed")!.querySelector<HTMLElement>(".schedule-results__goto")!)
    await user.click(screen.getByRole("button", { name: /Results \(5\)/ })) // reopen
    await user.click(resultRows().find((r) => r.dataset.videoId === "v_ema-wed")!.querySelector<HTMLElement>(".schedule-results__goto")!)

    expect(vi.mocked(window.scrollTo).mock.calls.length - scrollsAfterMount).toBe(2)
  })

  it("reopening after a row navigation does not drag the page back to where it was before", async () => {
    const user = userEvent.setup()
    renderGrid({ viewport: 390, creatorFilterActive: true })
    await user.click(resultRows().find((r) => r.dataset.videoId === "v_ema-wed")!.querySelector<HTMLElement>(".schedule-results__goto")!)
    const scrollsAfterNavigation = vi.mocked(window.scrollTo).mock.calls.length

    await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))

    expect(vi.mocked(window.scrollTo).mock.calls.length).toBe(scrollsAfterNavigation)
  })

  it("an avatar opens the existing stream handler and does not navigate the Schedule", async () => {
    const user = userEvent.setup()
    const { onSelectStream } = renderGrid({ viewport: 390, creatorFilterActive: true })
    const row = resultRows().find((candidate) => candidate.dataset.videoId === "v_ema-fri")!

    await user.click(within(row).getByRole("button", { name: "title ema-fri" }))

    expect(onSelectStream).toHaveBeenCalledTimes(1)
    expect(onSelectStream).toHaveBeenCalledWith(emaFri)
    expect(shownDate()).toBe(TODAY.toDateString())
    expect(window.scrollTo).toHaveBeenCalledTimes(1) // only the mount scroll
  })

  it("collapses to a header bar and reopens on the same day, without scrolling the Schedule itself", async () => {
    const user = userEvent.setup()
    renderGrid({ viewport: 390, creatorFilterActive: true })
    await user.click(screen.getByRole("button", { name: "Next day" })) // Tuesday, by the date navigator (a row click would collapse the drawer itself)

    await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
    expect(drawer()).toHaveClass("is-collapsed")
    expect(document.querySelector(".schedule-results__list")).toBeNull()
    expect(shownDate()).toBe(new Date(2026, 8, 22).toDateString())

    await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
    expect(drawer()).not.toHaveClass("is-collapsed")
    expect(resultRows()).toHaveLength(5)
    expect(shownDate()).toBe(new Date(2026, 8, 22).toDateString())
  })

  describe("page scroll across collapse and reopen", () => {
    let pageY = 0

    beforeEach(() => {
      pageY = 0
      vi.spyOn(window, "scrollY", "get").mockImplementation(() => pageY)
      vi.mocked(window.scrollTo).mockImplementation((_x, y) => {
        pageY = Number(y)
      })
    })

    it("puts the page back where it was before the collapse when the browser pulled it up meanwhile", async () => {
      const user = userEvent.setup()
      renderGrid({ viewport: 390, creatorFilterActive: true })
      pageY = 2500

      // Collapsing shortens the page, so the browser clamps the scroll position the moment it is read with the drawer collapsed.
      vi.spyOn(window, "scrollY", "get").mockImplementation(() => {
        if (drawer()?.classList.contains("is-collapsed")) pageY = Math.min(pageY, 2100)
        return pageY
      })
      await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
      expect(drawer()).toHaveClass("is-collapsed")
      expect(pageY).toBe(2100)

      await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
      expect(pageY).toBe(2500)
    })

    it("leaves the page where the user scrolled it while collapsed", async () => {
      const user = userEvent.setup()
      renderGrid({ viewport: 390, creatorFilterActive: true })
      pageY = 2500
      await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
      pageY = 1200 // the user scrolls the Schedule while the drawer is collapsed

      await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
      expect(pageY).toBe(1200)
    })

    it("does not scroll at all when the drawer is first opened", () => {
      renderGrid({ viewport: 390, creatorFilterActive: true })

      expect(window.scrollTo).toHaveBeenCalledTimes(1) // only the mount scroll
    })
  })

  it("is gone when the filter is cleared and opens afresh when one is applied again", async () => {
    const user = userEvent.setup()
    const view = renderGrid({ viewport: 390, creatorFilterActive: true })
    await user.click(screen.getByRole("button", { name: /Results \(5\)/ }))
    expect(drawer()).toHaveClass("is-collapsed")

    const props = { locale: "en" as const, days: WEEK, now: new Date(2026, 8, 21, 9, 10), selectedStreamId: null, onSelectStream: vi.fn() }
    view.rerender(<ScheduleGrid {...props} creatorFilterActive={false} />)
    expect(drawer()).toBeNull()
    view.rerender(<ScheduleGrid {...props} creatorFilterActive />)
    expect(drawer()).not.toHaveClass("is-collapsed")
  })

  it("shows an empty message when the filter matches nothing in the displayed days", () => {
    setViewport(390)
    render(<ScheduleGrid locale="en" days={makeWeek({})} now={new Date(2026, 8, 21, 9, 10)} selectedStreamId={null} onSelectStream={vi.fn()} creatorFilterActive />)

    expect(screen.getByText("No matching streams this week")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Results \(0\)/ })).toBeInTheDocument()
  })

  it("marks a live result with its badge", () => {
    renderGrid({ viewport: 390, creatorFilterActive: true })

    const emaRow = resultRows().find((row) => row.dataset.videoId === "v_ema-mon")!
    expect(within(emaRow).getByText("LIVE")).toBeInTheDocument()
  })
})
