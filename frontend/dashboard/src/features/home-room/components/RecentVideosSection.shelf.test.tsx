import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { buildOshiVideosRequest, type OshiVideosQuery, type VideoContentType, type VideoViewWindow } from "../model/oshiVideosQuery"
import type { VideoSortOption } from "../utils/recentVideosSelection"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))

const fetchMock = vi.mocked(fetchOshiVideos)
const fetchTopicsMock = vi.mocked(fetchVideoTopics)

/** Today's real backend taxonomy (src/tracking/video_topics.py's TOPICS), in its real order --
 * this file's own fixture for "what GET /topics happens to return right now", not a frontend
 * hardcoded topic list: RecentVideosSection itself has no knowledge of these ids or labels. */
const REAL_BACKEND_TOPICS: BackendVideoTopic[] = [
  { id: "valorant", labels: { en: "VALO" } },
  { id: "sf6", labels: { en: "SF6" } },
  { id: "apex", labels: { en: "Apex" } },
  { id: "minecraft", labels: { en: "Minecraft" } },
  { id: "singing", labels: { en: "Singing" } },
  { id: "mv", labels: { en: "MV" } },
  { id: "chatting", labels: { en: "Chatting" } },
  { id: "other", labels: { en: "Other" } },
]

const [CREATOR_A, CREATOR_B] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const LEGACY_B = toLegacyRosterId(CREATOR_B)

function video(videoId: string): RecentVideo {
  return { videoId, title: `Title ${videoId}`, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "live_archive", viewCount: 10 }
}

function page(ids: string[]): OshiVideosPage {
  return { videos: ids.map(video), nextOffset: ids.length, hasMore: false }
}

function deferred() {
  let resolve!: (value: OshiVideosPage) => void
  const promise = new Promise<OshiVideosPage>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function renderSection(creatorId: string) {
  const onSelectVideo = vi.fn()
  const view = render(<RecentVideosSection creatorId={creatorId} onSelectVideo={onSelectVideo} />)
  return {
    ...view,
    switchCreator: (next: string) => view.rerender(<RecentVideosSection creatorId={next} onSelectVideo={onSelectVideo} />),
  }
}

type User = ReturnType<typeof userEvent.setup>

const lastQuery = (): OshiVideosQuery => fetchMock.mock.calls.at(-1)![0]
const lastRequest = () => buildOshiVideosRequest(lastQuery())

/** Backend topic tags render only after GET /topics resolves (data/videoTopics.ts's
 * fetchVideoTopics, mocked above) -- findByText waits for that, same as any other
 * async-appearing element; the 3 special filters are present immediately, and waiting
 * for them resolves on the very next check. */
async function pickTag(user: User, label: string) {
  await user.click(await screen.findByText(label))
}
const contentTypeSelect = () => screen.getByRole("combobox", { name: "Content type" })
const sortSelect = () => screen.getByRole("combobox", { name: "Sort videos" })
const windowSelect = () => screen.queryByRole("combobox", { name: "Period" })

async function pickContentType(user: User, value: VideoContentType) {
  await user.selectOptions(contentTypeSelect(), value)
}
async function pickSort(user: User, value: VideoSortOption) {
  await user.selectOptions(sortSelect(), value)
}
async function pickWindow(user: User, value: VideoViewWindow) {
  await user.selectOptions(windowSelect()!, value)
}

const optionValues = (select: HTMLElement) => Array.from(select.querySelectorAll("option")).map((option) => option.value)
const optionLabels = (select: HTMLElement) => Array.from(select.querySelectorAll("option")).map((option) => option.textContent)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(page([]))
  fetchTopicsMock.mockReset()
  fetchTopicsMock.mockResolvedValue(REAL_BACKEND_TOPICS)
})

describe("Home Oshi Videos: quick filters are backend queries for the current creator", () => {
  it("最新影片 (the default) = this creator + all topics + upload + archived + newest", async () => {
    renderSection(LEGACY_A)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic: "all", contentType: "upload", sort: "newest", viewWindow: "total" })
    const request = lastRequest()
    expect(request.path).toContain(`/creators/${CREATOR_A.creatorId}/videos/recent?`)
    expect(request.path).toContain("liveStatus=archived")
  })

  it("最新直播 = this creator + all topics + live + archived + newest, and never reads /live-streams", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)

    await pickTag(user, "Latest Live")

    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic: "all", contentType: "live", sort: "newest", viewWindow: "total" })
    expect(lastRequest().path).toContain("liveStatus=archived")
    expect(lastRequest().path).not.toContain("live-streams")
  })

  it("a quick filter ignores whatever the dropdowns were set to for a topic tag", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await pickContentType(user, "live")
    await pickSort(user, "mostViews")
    await pickWindow(user, "7d")

    await pickTag(user, "Latest Videos")

    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic: "all", contentType: "upload", sort: "newest", viewWindow: "total" })
  })

  it("both quick filters follow the current creator when it changes", async () => {
    const user = userEvent.setup()
    const { switchCreator } = renderSection(LEGACY_A)

    switchCreator(LEGACY_B)
    await waitFor(() => expect(lastQuery().creatorId).toBe(CREATOR_B.creatorId))
    expect(lastQuery()).toMatchObject({ contentType: "upload", sort: "newest" })

    await pickTag(user, "Latest Live")
    switchCreator(LEGACY_A)
    await waitFor(() => expect(lastQuery().creatorId).toBe(CREATOR_A.creatorId))
    expect(lastQuery()).toMatchObject({ topic: "all", contentType: "live", sort: "newest" })
  })
})

describe("Home Oshi Videos: Sort, period and content type controls", () => {
  it("the Sort dropdown has exactly 最新上架 / 最舊上架 / 最多觀看次數 -- most viewed is selectable and nothing is nested", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "ALL")

    expect(optionValues(sortSelect())).toEqual(["newest", "oldest", "mostViews"])
    expect(optionLabels(sortSelect())).toEqual(["Newest", "Oldest", "Most Views"])
    expect(sortSelect().querySelector("optgroup")).toBeNull() // no nested metric submenu
    for (const nested of ["All", "1d", "7d", "30d"]) expect(optionLabels(sortSelect())).not.toContain(nested)

    await pickSort(user, "mostViews") // directly selectable
    expect(lastQuery()).toMatchObject({ sort: "mostViews" })
  })

  it("the period dropdown is absent for newest and oldest and appears beside Sort only for most viewed", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "ALL")

    expect(windowSelect()).not.toBeInTheDocument() // newest
    await pickSort(user, "oldest")
    expect(windowSelect()).not.toBeInTheDocument() // oldest

    await pickSort(user, "mostViews")
    const period = windowSelect()!
    expect(period).toBeInTheDocument()
    expect(optionValues(period)).toEqual(["total", "1d", "7d", "30d"])
    expect(optionLabels(period)).toEqual(["All", "1d", "7d", "30d"])
    expect(sortSelect().nextElementSibling).toBe(period) // immediately beside Sort

    await pickSort(user, "newest")
    expect(windowSelect()).not.toBeInTheDocument()
  })

  it("the period selects the ranking metric: All -> total, 1d, 7d, 30d", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await pickSort(user, "mostViews")
    expect(lastRequest().path).toContain("metric=total")

    for (const window of ["1d", "7d", "30d", "total"] as const) {
      await pickWindow(user, window)
      expect(lastQuery()).toMatchObject({ sort: "mostViews", viewWindow: window })
      expect(lastRequest().path).toContain("/videos/ranking?")
      expect(lastRequest().path).toContain(`metric=${window}`)
    }
  })

  it("switching from most viewed to newest/oldest stops applying the metric", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await pickSort(user, "mostViews")
    await pickWindow(user, "30d")

    for (const sort of ["newest", "oldest"] as const) {
      await pickSort(user, sort)
      expect(lastRequest().path).toContain("/videos/recent?")
      expect(lastRequest().path).toContain(`sort=${sort}`)
      expect(lastRequest().path).not.toContain("metric")
    }
  })

  it("the Content type dropdown maps 全部/直播/影片 to all/live/upload", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "ALL")

    expect(optionValues(contentTypeSelect())).toEqual(["all", "live", "upload"])
    expect(optionLabels(contentTypeSelect())).toEqual(["All", "Live", "Videos"])
    for (const contentType of ["live", "upload", "all"] as const) {
      await pickContentType(user, contentType)
      expect(lastQuery().contentType).toBe(contentType)
      expect(lastRequest().path).toContain(`contentType=${contentType}`)
    }
  })

  it("changing the topic keeps the content type, and changing the content type keeps the topic", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await pickContentType(user, "live")
    expect(lastQuery()).toMatchObject({ topic: "sf6", contentType: "live" })

    await pickTag(user, "VALO")
    expect(lastQuery()).toMatchObject({ topic: "valorant", contentType: "live" })

    await pickContentType(user, "upload")
    expect(lastQuery()).toMatchObject({ topic: "valorant", contentType: "upload" })
  })

  it("keeps the sort and period when the topic or content type changes", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await pickSort(user, "mostViews")
    await pickWindow(user, "7d")

    await pickTag(user, "Apex")
    await pickContentType(user, "upload")

    expect(lastQuery()).toMatchObject({ topic: "apex", contentType: "upload", sort: "mostViews", viewWindow: "7d" })
  })

  it.each<[string, VideoContentType, string]>([
    ["sf6", "live", "SF6"],
    ["valorant", "upload", "VALO"],
  ])("%s + %s supports newest, oldest and most viewed All/1d/7d/30d for the current creator", async (topic, contentType, tag) => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, tag)
    await pickContentType(user, contentType)

    for (const sort of ["newest", "oldest"] as const) {
      await pickSort(user, sort)
      expect(lastQuery()).toMatchObject({ creatorId: CREATOR_A.creatorId, topic, contentType, sort })
    }
    await pickSort(user, "mostViews")
    for (const viewWindow of ["total", "1d", "7d", "30d"] as const) {
      await pickWindow(user, viewWindow)
      expect(lastQuery()).toMatchObject({ creatorId: CREATOR_A.creatorId, topic, contentType, sort: "mostViews", viewWindow })
    }
  })

  it.each<["SF6" | "VALO", VideoContentType]>([
    ["SF6", "upload"],
    ["VALO", "live"],
  ])("%s + %s supports newest and oldest", async (tag, contentType) => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, tag)
    await pickContentType(user, contentType)

    await pickSort(user, "newest")
    expect(lastQuery()).toMatchObject({ sort: "newest", contentType })
    await pickSort(user, "oldest")
    expect(lastQuery()).toMatchObject({ sort: "oldest", contentType })
  })

  it("every topic tag, including ALL and Other, queries with its own backend topic id", async () => {
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    const expected: [string, string][] = [
      ["ALL", "all"], ["SF6", "sf6"], ["VALO", "valorant"], ["Minecraft", "minecraft"],
      ["Apex", "apex"], ["Singing", "singing"], ["MV", "mv"], ["Chatting", "chatting"], ["Other", "other"],
    ]

    for (const [label, topic] of expected) {
      await pickTag(user, label)
      expect(lastQuery()).toMatchObject({ creatorId: CREATOR_A.creatorId, topic })
    }
  })
})

describe("Home Oshi Videos: creator switching and request races", () => {
  it("switching the current Oshi re-queries with the NEW creator and the same filter state", async () => {
    const user = userEvent.setup()
    const { switchCreator } = renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await pickContentType(user, "live")
    await pickSort(user, "mostViews")
    await pickWindow(user, "7d")
    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic: "sf6", contentType: "live", sort: "mostViews", viewWindow: "7d", excludeShorts: true })

    switchCreator(LEGACY_B)

    await waitFor(() => expect(lastQuery().creatorId).toBe(CREATOR_B.creatorId))
    expect(lastQuery()).toEqual({ creatorId: CREATOR_B.creatorId, topic: "sf6", contentType: "live", sort: "mostViews", viewWindow: "7d", excludeShorts: true })
  })

  it("the previous creator's videos disappear immediately, and its late response can never replace the new creator's shelf", async () => {
    const a = deferred()
    const b = deferred()
    fetchMock.mockImplementation((query) => (query.creatorId === CREATOR_A.creatorId ? a.promise : b.promise))
    const user = userEvent.setup()
    const { switchCreator } = renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await act(async () => a.resolve(page(["a-video"])))
    expect(screen.getByRole("button", { name: /Title a-video/ })).toBeInTheDocument()

    switchCreator(LEGACY_B)
    expect(screen.queryByRole("button", { name: /Title a-video/ })).not.toBeInTheDocument() // gone at once, while B loads

    await act(async () => b.resolve(page(["b-video"])))
    expect(screen.getByRole("button", { name: /Title b-video/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Title a-video/ })).not.toBeInTheDocument()
  })

  it("an in-flight request for the old creator finishing after the switch is ignored", async () => {
    const aSlow = deferred()
    const b = deferred()
    fetchMock.mockImplementation((query) => (query.creatorId === CREATOR_A.creatorId ? aSlow.promise : b.promise))
    const user = userEvent.setup()
    const { switchCreator } = renderSection(LEGACY_A)
    await pickTag(user, "SF6") // A is still loading...

    switchCreator(LEGACY_B)
    await act(async () => b.resolve(page(["b-video"])))
    await act(async () => aSlow.resolve(page(["a-late"]))) // ...and only now finishes

    expect(screen.getByRole("button", { name: /Title b-video/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Title a-late/ })).not.toBeInTheDocument()
  })

  it("rapid SF6 + live + views/7d -> VALORANT + upload + newest never lets the first request replace the second", async () => {
    const calls: { query: OshiVideosQuery; resolve: (value: OshiVideosPage) => void }[] = []
    fetchMock.mockImplementation((query) => {
      const d = deferred()
      calls.push({ query, resolve: d.resolve })
      return d.promise
    })
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await pickContentType(user, "live")
    await pickSort(user, "mostViews")
    await pickWindow(user, "7d")
    await pickTag(user, "VALO")
    await pickContentType(user, "upload")
    await pickSort(user, "newest")
    expect(lastQuery()).toMatchObject({ topic: "valorant", contentType: "upload", sort: "newest" })

    // The newest request answers first; every earlier (SF6 / views) request answers LAST.
    const current = calls.at(-1)!
    await act(async () => current.resolve(page(["valorant-video"])))
    for (const stale of calls.slice(0, -1)) await act(async () => stale.resolve(page(["sf6-stale"])))

    expect(screen.getByRole("button", { name: /Title valorant-video/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Title sf6-stale/ })).not.toBeInTheDocument()
  })
})

describe("Home Oshi Videos: empty results", () => {
  it("shows the existing empty state for a valid empty combination and never reuses the previous videos", async () => {
    fetchMock.mockImplementation(async (query) => (query.topic === "sf6" ? page(["old-1"]) : page([])))
    const user = userEvent.setup()
    renderSection(LEGACY_A)
    await pickTag(user, "SF6")
    await waitFor(() => expect(screen.getByRole("button", { name: /Title old-1/ })).toBeInTheDocument())

    await pickTag(user, "Minecraft")

    await waitFor(() => expect(screen.getByText("No videos")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Title old-1/ })).not.toBeInTheDocument()
  })
})
