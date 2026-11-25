import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos } from "../data/oshiVideos"
import { fetchOnThisDay, type OnThisDayResult } from "../data/onThisDay"
import { fetchVideoTopics } from "../data/videoTopics"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

// F37 On this day: a view of the Video List's own track. The data below is DETERMINISTIC TEST DATA, not real catalog data.

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../data/onThisDay", async (importOriginal) => ({ ...(await importOriginal<typeof import("../data/onThisDay")>()), fetchOnThisDay: vi.fn() }))
const noLiveStreams = vi.hoisted(() => ({ streams: [], isLoading: false, error: null }))
vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: () => noLiveStreams }))

const shelfMock = vi.mocked(fetchOshiVideos)
const memoriesMock = vi.mocked(fetchOnThisDay)
const topicsMock = vi.mocked(fetchVideoTopics)

const TOPICS: BackendVideoTopic[] = [
  { id: "mv", labels: { "zh-TW": "MV", en: "MV", ja: "MV" } },
  { id: "minecraft", labels: { "zh-TW": "Minecraft", en: "Minecraft", ja: "Minecraft" } },
  { id: "other", labels: { "zh-TW": "其他", en: "Other", ja: "その他" } },
]

const [CREATOR] = getCreators()
const LEGACY = toLegacyRosterId(CREATOR)

const RESULT: OnThisDayResult = {
  years: [
    {
      year: 2025,
      videos: [
        { videoId: "s2025", title: "Stream 2025", topic: "minecraft", contentType: "live", date: "2025-10-28", eventAt: "2025-10-28T10:00:00+00:00", dateKind: "actualStart" },
        { videoId: "u2025", title: "Upload 2025", topic: "mv", contentType: "upload", date: "2025-10-28", eventAt: "2025-10-28T03:00:00+00:00", dateKind: "published" },
      ],
    },
    { year: 2023, videos: [{ videoId: "s2023", title: "Stream 2023", topic: null, contentType: "live", date: "2023-10-28", eventAt: "2023-10-27T16:30:00+00:00", dateKind: "actualStart" }] },
  ],
  total: 3,
  truncated: false,
  coverage: { catalogStart: "2019-07-18", undatedLivestreams: 12 },
  unavailable: false,
}
const EMPTY: OnThisDayResult = { years: [], total: 0, truncated: false, coverage: { catalogStart: "2019-07-18", undatedLivestreams: 0 }, unavailable: false }

type User = ReturnType<typeof userEvent.setup>
const lastCall = () => memoriesMock.mock.calls.at(-1)!
const lastDate = () => lastCall()[1]
const lastFilters = () => lastCall()[2]
const cardTitles = () => Array.from(document.querySelectorAll(".oshi-video-card__title")).map((node) => node.textContent)
const cardMetas = () => Array.from(document.querySelectorAll(".oshi-video-card__meta")).map((node) => node.textContent)
const yearLabels = () => Array.from(document.querySelectorAll(".oshi-memories__year-label")).map((node) => node.textContent)

async function open(onSelectVideo = vi.fn()) {
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  render(<RecentVideosSection creatorId={LEGACY} onSelectVideo={onSelectVideo} />)
  await waitFor(() => expect(screen.getByText("Minecraft")).toBeTruthy())
  const user: User = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Show videos from this date in earlier years" }))
  return { user, onSelectVideo }
}

beforeEach(() => {
  // Only Date is faked: 2026-10-27 16:00 UTC is already 2026-10-28 01:00 in Tokyo.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T16:00:00Z") })
  window.localStorage.clear()
  shelfMock.mockReset().mockResolvedValue({ videos: [], nextOffset: 0, hasMore: false })
  topicsMock.mockReset().mockResolvedValue(TOPICS)
  memoriesMock.mockReset().mockResolvedValue(RESULT)
})
afterEach(() => vi.useRealTimers())

describe("On this day: default view", () => {
  it("starts on today's Tokyo month/day for the current creator, with the shelf's own default filters", async () => {
    await open()

    await waitFor(() => expect(memoriesMock).toHaveBeenCalled())
    expect(lastCall()[0]).toBe(CREATOR.creatorId)
    expect(lastDate()).toEqual({ month: 10, day: 28 })
    expect(lastFilters()).toEqual({ topic: "all", contentType: "all", excludeShorts: true })
  })

  it("groups by year, newest first, with each video's date, what the date means and its topic", async () => {
    await open()

    await waitFor(() => expect(yearLabels()).toEqual(["2025", "2023"]))
    expect(cardTitles()).toEqual(["Stream 2025", "Upload 2025", "Stream 2023"])
    expect(cardMetas().slice(0, 3)).toEqual(["2025-10-28 · Streamed · Minecraft", "2025-10-28 · Published · MV", "2023-10-28 · Streamed"])
  })

  it("discloses what the catalog covers and the livestreams that cannot be dated (never as 'no videos')", async () => {
    await open()

    const note = await screen.findByRole("note")
    expect(note.textContent).toContain("Catalog covers from 2019-07-18")
    expect(note.textContent).toContain("12 livestreams have no recorded start date yet and cannot appear here")
  })

  it("opens a memory through the Video List's own selection path", async () => {
    const { user, onSelectVideo } = await open()

    await user.click(await screen.findByText("Upload 2025"))

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "u2025", title: "Upload 2025" })
  })

  it("does not fetch the shelf's own pages while it is open, and the shelf returns when it is closed", async () => {
    const { user } = await open()
    await waitFor(() => expect(memoriesMock).toHaveBeenCalled())
    shelfMock.mockClear()
    await user.click(screen.getByRole("button", { name: "Next day" }))
    await waitFor(() => expect(lastDate()).toEqual({ month: 10, day: 29 }))
    expect(shelfMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Show videos from this date in earlier years" }))

    await waitFor(() => expect(shelfMock).toHaveBeenCalled())
    expect(document.querySelector(".oshi-memories__year")).toBeNull()
    expect(screen.getByRole("combobox", { name: "Sort videos" })).toBeTruthy()
  })
})

describe("On this day: date navigation", () => {
  it("steps to the previous and next day", async () => {
    const { user } = await open()
    await waitFor(() => expect(memoriesMock).toHaveBeenCalled())

    await user.click(screen.getByRole("button", { name: "Previous day" }))
    await waitFor(() => expect(lastDate()).toEqual({ month: 10, day: 27 }))
    await user.click(screen.getByRole("button", { name: "Next day" }))
    await user.click(screen.getByRole("button", { name: "Next day" }))
    await waitFor(() => expect(lastDate()).toEqual({ month: 10, day: 29 }))
  })

  it("wraps across the year boundary and passes through February 29", async () => {
    const { user } = await open()
    await user.selectOptions(screen.getByRole("combobox", { name: "Month" }), "12")
    await user.selectOptions(screen.getByRole("combobox", { name: "Day" }), "31")
    await user.click(screen.getByRole("button", { name: "Next day" }))
    await waitFor(() => expect(lastDate()).toEqual({ month: 1, day: 1 }))

    await user.selectOptions(screen.getByRole("combobox", { name: "Month" }), "3")
    await user.selectOptions(screen.getByRole("combobox", { name: "Day" }), "1")
    await user.click(screen.getByRole("button", { name: "Previous day" }))
    await waitFor(() => expect(lastDate()).toEqual({ month: 2, day: 29 }))
  })

  it("February offers the 29th and a month change keeps the day valid", async () => {
    const { user } = await open()
    await user.selectOptions(screen.getByRole("combobox", { name: "Month" }), "1")
    await user.selectOptions(screen.getByRole("combobox", { name: "Day" }), "31")

    await user.selectOptions(screen.getByRole("combobox", { name: "Month" }), "2")

    await waitFor(() => expect(lastDate()).toEqual({ month: 2, day: 29 }))
    const dayOptions = within(screen.getByRole("combobox", { name: "Day" })).getAllByRole("option")
    expect(dayOptions).toHaveLength(29)
  })
})

describe("On this day: the Video List's own filters apply", () => {
  it("a Topic Tag filters by that topic and ALL clears it", async () => {
    const { user } = await open()
    await waitFor(() => expect(memoriesMock).toHaveBeenCalled())

    await user.click(screen.getByText("Minecraft"))
    await waitFor(() => expect(lastFilters()).toEqual({ topic: "minecraft", contentType: "all", excludeShorts: true }))
    await user.click(screen.getByText("ALL"))
    await waitFor(() => expect(lastFilters().topic).toBe("all"))
  })

  it("the content-type dropdown narrows to livestreams or videos", async () => {
    const { user } = await open()
    await waitFor(() => expect(memoriesMock).toHaveBeenCalled())

    await user.selectOptions(screen.getByRole("combobox", { name: "Content type" }), "live")
    await waitFor(() => expect(lastFilters().contentType).toBe("live"))
    await user.selectOptions(screen.getByRole("combobox", { name: "Content type" }), "upload")
    await waitFor(() => expect(lastFilters().contentType).toBe("upload"))
  })

  it("Latest Live and Short are fixed content types", async () => {
    const { user } = await open()
    await waitFor(() => expect(memoriesMock).toHaveBeenCalled())

    await user.click(screen.getByText("Latest Live"))
    await waitFor(() => expect(lastFilters()).toEqual({ topic: "all", contentType: "live", excludeShorts: true }))
    await user.click(screen.getByText("Short"))
    await waitFor(() => expect(lastFilters()).toEqual({ topic: "all", contentType: "short", excludeShorts: false }))
  })
})

describe("On this day: states", () => {
  it("an empty date says so and still says what the catalog covers", async () => {
    memoriesMock.mockResolvedValue(EMPTY)
    await open()

    const status = await screen.findByText("No matching videos on this date in earlier years")
    expect(status.parentElement?.textContent).toContain("Catalog covers from 2019-07-18")
  })

  it("a failed request is an error state, not an empty one", async () => {
    memoriesMock.mockRejectedValue(new Error("boom"))
    await open()

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.queryByText("No matching videos on this date in earlier years")).toBeNull()
  })

  it("a creator without historical data says so", async () => {
    memoriesMock.mockResolvedValue({ ...EMPTY, unavailable: true })
    await open()

    expect(await screen.findByText("Historical data is not available for this creator yet")).toBeTruthy()
  })

  it("says when the list was cut at the backend's cap", async () => {
    memoriesMock.mockResolvedValue({ ...RESULT, truncated: true, total: 500 })
    await open()

    expect((await screen.findByRole("note")).textContent).toContain("Showing the first 500 results")
  })
})
