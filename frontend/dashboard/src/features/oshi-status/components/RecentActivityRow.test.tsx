import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecentActivityRow } from "./RecentActivityRow"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

vi.mock("../../../shared/newContent/newContentTracking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/newContent/newContentTracking")>()
  return { ...actual, markContentSeen: vi.fn(actual.markContentSeen) }
})

import { markContentSeen, useNewContent } from "../../../shared/newContent/newContentTracking"

const NOW = new Date("2026-10-22T12:00:00Z")

function row(videoId: string, contentFormat: RecentVideo["contentFormat"], overrides: Partial<RecentVideo> = {}): RecentVideo {
  return { videoId, title: `title-${videoId}`, publishedAt: "2026-10-22T10:00:00Z", contentFormat, ...overrides }
}

function renderRow(entry: RecentVideo, onOpen = vi.fn()) {
  render(<RecentActivityRow entry={entry} now={NOW} locale="en" timeFormat="24h" onOpen={onOpen} />)
  return { onOpen }
}

function isUnseen(videoId: string): boolean {
  function Probe() {
    return <span data-testid="probe-result">{String(useNewContent().isUnseen(videoId))}</span>
  }
  const { getByTestId, unmount } = render(<Probe />)
  const value = getByTestId("probe-result").textContent === "true"
  unmount() // each call renders its own probe; unmount at once so repeated calls within one test never collide in the DOM
  return value
}

beforeEach(() => {
  resetAllSharedStateForTests()
  vi.mocked(markContentSeen).mockClear()
})

afterEach(() => {
  resetAllSharedStateForTests()
})

describe("RecentActivityRow: opening a not-yet-watchable row never marks the final video seen", () => {
  it.each([
    ["an upcoming Premiere's waiting page", "premiere"],
    ["a currently live stream", "live_now"],
    ["an upcoming ordinary stream", "live_upcoming"],
    ["an ended, archive-not-ready-yet placeholder", "archive_pending"],
  ] as const)("%s", (_label, contentFormat) => {
    const entry = row("v1", contentFormat)

    renderRow(entry)
    fireEvent.click(screen.getByRole("button", { name: `title-${entry.videoId}` }))

    expect(markContentSeen).not.toHaveBeenCalled()
    expect(isUnseen("v1")).toBe(true)
  })

  it.each([
    ["a completed archive", "live_archive"],
    ["an ordinary uploaded video", "normal_video"],
    ["a completed Premiere (now an ordinary video row)", "normal_video"],
  ] as const)("opening %s DOES mark it seen", (_label, contentFormat) => {
    const entry = row("v2", contentFormat)

    renderRow(entry)
    fireEvent.click(screen.getByRole("button", { name: `title-${entry.videoId}` }))

    expect(markContentSeen).toHaveBeenCalledWith("v2")
    expect(isUnseen("v2")).toBe(false)
  })

  it("a PREVIOUSLY WATCHED Premiere stays seen across the pending-archive and archived transition -- no re-marking needed, no double credit", () => {
    markContentSeen("v3") // already watched from an earlier visit (e.g. watched live, or opened the finished archive once before)
    expect(isUnseen("v3")).toBe(false)

    renderRow(row("v3", "archive_pending"))
    expect(isUnseen("v3")).toBe(false) // still seen -- the pending placeholder never resets watched state

    renderRow(row("v3", "normal_video"))
    expect(isUnseen("v3")).toBe(false) // still seen once it becomes the real archived row
  })

  it("the SAME videoId transitioning premiere -> archive_pending -> normal_video is marked seen only once, by the final click", () => {
    const { onOpen: onOpenAnnouncement } = renderRow(row("v4", "premiere"))
    fireEvent.click(screen.getByRole("button", { name: "title-v4" }))
    expect(markContentSeen).not.toHaveBeenCalled()
    expect(onOpenAnnouncement).toHaveBeenCalledTimes(1)

    renderRow(row("v4", "archive_pending"))
    fireEvent.click(screen.getAllByRole("button", { name: "title-v4" })[1])
    expect(markContentSeen).not.toHaveBeenCalled()

    renderRow(row("v4", "normal_video"))
    fireEvent.click(screen.getAllByRole("button", { name: "title-v4" })[2])
    expect(markContentSeen).toHaveBeenCalledTimes(1)
    expect(markContentSeen).toHaveBeenCalledWith("v4")
  })
})
