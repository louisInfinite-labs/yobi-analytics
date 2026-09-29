import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { SLOT_COUNT } from "../model/scheduleGrid"
import type { ScheduledStream, ScheduledStreamStatus } from "../model/scheduledStream"

const ROW_HEIGHT = 38

function makeStream(id: string, status: ScheduledStreamStatus): ScheduledStream {
  return { id, channelId: `ch_${id}`, videoId: `v_${id}`, title: `title ${id}`, description: "", status, scheduledStartMs: 0, topics: [] }
}

function makeDays(streamsBySlot: Record<number, ScheduledStream[]>): ScheduleDay[] {
  const slots = Array.from({ length: SLOT_COUNT }, (_, index) => streamsBySlot[index] ?? [])
  return [{ date: new Date(2026, 8, 21), isToday: true, slots }]
}

function renderGrid(days: ScheduleDay[], now = new Date(2026, 8, 21, 22, 10)) {
  const props = { locale: "en" as const, selectedStreamId: null, onSelectStream: () => {} }
  const view = render(<ScheduleGrid {...props} days={days} now={now} />)
  return { ...view, props, grid: view.container.querySelector<HTMLElement>(".schedule-grid")! }
}

// jsdom has no layout: give each time-label a row-height-based rect so the
// scroll math has something to measure.
let scrollToSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const index = this.classList.contains("time-label") ? Array.from(this.parentElement!.children).indexOf(this) : 0
    return { top: index * ROW_HEIGHT, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
  })
  // The grid no longer owns its own scroll (Schedule uses normal page
  // scrolling; see schedule.css's own comment on .schedule-page) -- the
  // initial-position effect now calls window.scrollTo instead of setting
  // grid.scrollTop, so that's what these tests assert against. jsdom has no
  // real window.scrollTo implementation, hence the mock.
  scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("ScheduleGrid initial scroll", () => {
  it("puts the earliest live row at the top", () => {
    renderGrid(makeDays({ 41: [makeStream("a", "live")], 43: [makeStream("b", "live")] }))
    expect(scrollToSpy).toHaveBeenCalledWith(0, 41 * ROW_HEIGHT)
  })

  it("puts the current local slot at the top when nothing is live", () => {
    renderGrid(makeDays({ 41: [makeStream("a", "upcoming")] }))
    expect(scrollToSpy).toHaveBeenCalledWith(0, 44 * ROW_HEIGHT)
  })

  it("does not move the viewport again when days/now refresh", () => {
    const { rerender, props } = renderGrid(makeDays({ 41: [makeStream("a", "live")] }))
    scrollToSpy.mockClear()
    rerender(<ScheduleGrid {...props} days={makeDays({ 10: [makeStream("b", "live")] })} now={new Date(2026, 8, 21, 22, 40)} />)
    expect(scrollToSpy).not.toHaveBeenCalled()
  })
})

describe("ScheduleGrid avatar LIVE badge", () => {
  it("shows the badge only on avatars whose own status is live", () => {
    const { container } = renderGrid(
      makeDays({ 5: [makeStream("a", "live"), makeStream("b", "upcoming"), makeStream("c", "live"), makeStream("d", "ended")] }),
    )
    const items = Array.from(container.querySelectorAll(".stream-avatar-item"))
    expect(items.map((item) => item.querySelector(".stream-avatar-live-badge") !== null)).toEqual([true, false, true, false])
    expect(container.querySelector(".stream-avatar-live-badge")).toHaveTextContent("LIVE")
  })

  it("keeps the badge outside the avatar button so it never sits on the avatar", () => {
    const { container } = renderGrid(makeDays({ 5: [makeStream("a", "live")] }))
    expect(container.querySelector(".stream-avatar-button .stream-avatar-live-badge")).toBeNull()
    expect(container.querySelector(".stream-avatar-item > .stream-avatar-live-badge")).not.toBeNull()
  })

  it("does not badge an upcoming stream that starts within the hour", () => {
    const soon = { ...makeStream("a", "upcoming"), scheduledStartMs: new Date(2026, 8, 21, 22, 40).getTime() }
    const { container } = renderGrid(makeDays({ 45: [soon] }))
    expect(container.querySelector(".stream-avatar-live-badge")).toBeNull()
  })
})
