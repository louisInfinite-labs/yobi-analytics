import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import { StreamDetailModal } from "./StreamDetailModal"
import { LiveSchedulePage } from "../../../pages/schedule/LiveSchedulePage"
import { getScheduleCreatorName } from "../utils/scheduleCreatorName"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import * as liveStreams from "../../../shared/api/liveStreams"
import { SLOT_COUNT } from "../model/scheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import type { ScheduledStream } from "../model/scheduledStream"

vi.mock("../../../shared/api/liveStreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/api/liveStreams")>()),
  fetchLiveStreams: vi.fn(),
}))

// The Hololive official channel is a registry creator (creatorId "hololive_official", legacy roster id "ch_hololive_official") that the Schedule's
// own mock roster does not list. Its canonical user-facing name must come from the Creator Registry, never the raw id.
const OFFICIAL_ID = "ch_hololive_official"
const OFFICIAL_NAME = "hololive ホロライブ - VTuber Group"
const NOW = new Date(2026, 8, 23, 12, 0, 0)

function officialStream(overrides: Partial<ScheduledStream> = {}): ScheduledStream {
  return {
    id: "official-1",
    channelId: OFFICIAL_ID,
    videoId: "official_video",
    title: "Official broadcast",
    description: "",
    status: "upcoming",
    scheduledStartMs: NOW.getTime() + 60 * 60_000,
    topics: [],
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([])
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("getScheduleCreatorName", () => {
  it("resolves the Hololive official channel through the Creator Registry, not to its raw id", () => {
    expect(getScheduleCreatorName(OFFICIAL_ID)).toBe(OFFICIAL_NAME)
  })

  it("keeps the roster's own name first for a creator it lists, and the raw id only for an id nothing knows", () => {
    expect(getScheduleCreatorName("ch_aizawa_ema")).toBe("藍沢エマ")
    expect(getScheduleCreatorName("ch_not_a_real_creator")).toBe("ch_not_a_real_creator")
  })
})

describe("Schedule shows the canonical name for the Hololive official channel", () => {
  it("the stream detail dialog", () => {
    render(<StreamDetailModal stream={officialStream()} locale="en" now={NOW} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)

    expect(document.querySelector(".creator-detail-name")).toHaveTextContent(new RegExp(`^${OFFICIAL_NAME}$`))
    expect(document.body.textContent).not.toContain(OFFICIAL_ID)
  })

  it("the +N popover's hidden-stream rows", async () => {
    const others: ScheduledStream[] = Array.from({ length: 3 }, (_, index) => officialStream({ id: `s${index}`, channelId: "ch_aizawa_ema", videoId: `v${index}`, title: `other ${index}` }))
    const streams = [...others, officialStream()] // four streams show every avatar; a fifth makes the official one hidden
    streams.push(officialStream({ id: "official-2", videoId: "official_video_2", title: "Second official broadcast" }))
    const slots = Array.from({ length: SLOT_COUNT }, (_, slot) => (slot === 10 ? streams : []))
    const data: ScheduleDay[] = [{ date: new Date(2026, 8, 23), isToday: true, slots }]
    render(<ScheduleGrid locale="en" days={data} now={NOW} selectedStreamId={null} onSelectStream={() => {}} />)

    await userEvent.setup().hover(document.querySelector<HTMLElement>(".more-streams")!)

    const names = Array.from(document.querySelectorAll(".hidden-streams-popover__creator")).map((node) => node.textContent)
    expect(names).toEqual([OFFICIAL_NAME, OFFICIAL_NAME])
    expect(document.body.textContent).not.toContain(OFFICIAL_ID)
  })

  it("the whole page: detail dialog and creator filter, from a real /live-streams item", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([
      {
        videoId: "official_video",
        creatorId: "hololive_official",
        channelName: "hololive Official",
        title: "Official broadcast",
        status: "upcoming",
        scheduledStart: new Date(2026, 8, 23, 13, 0, 0).toISOString(),
        actualStart: null,
        thumbnailUrl: "https://img.youtube.com/vi/official_video/hqdefault.jpg",
      },
    ])
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { container } = render(<LiveSchedulePage />)
    await waitFor(() => expect(container.querySelector(".stream-avatar-button")).toBeInTheDocument())

    await user.click(container.querySelector<HTMLElement>(".stream-avatar-button")!)
    expect(screen.getByRole("dialog").querySelector(".creator-detail-name")).toHaveTextContent(new RegExp(`^${OFFICIAL_NAME}$`))
    await user.keyboard("{Escape}")

    await user.click(container.querySelector<HTMLElement>(".schedule-creator-filter")!)
    const tileNames = Array.from(document.querySelectorAll(".schedule-creator-item__name")).map((node) => node.textContent)
    expect(tileNames).toContain(OFFICIAL_NAME)
    expect(document.body.textContent).not.toContain(OFFICIAL_ID)
  })
})
