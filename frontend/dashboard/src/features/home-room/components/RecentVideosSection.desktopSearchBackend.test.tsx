import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, resolveCreatorKey, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { fetchVideoSearch } from "../../video-search/data/videoSearch"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

// The approved desktop search box (PR #118: always visible, inline icon, no button, no collapsed state) now drives the multilingual
// backend search (GET /creators/{creatorId}/videos/search via features/video-search) instead of being UI-only.

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../../video-search/data/videoSearch", () => ({ fetchVideoSearch: vi.fn() }))

const fetchShelfMock = vi.mocked(fetchOshiVideos)
const fetchTopicsMock = vi.mocked(fetchVideoTopics)
const fetchSearchMock = vi.mocked(fetchVideoSearch)

const TOPICS: BackendVideoTopic[] = [
  { id: "valorant", labels: { en: "VALO" } },
  { id: "minecraft", labels: { en: "Minecraft" } },
]

const [CREATOR_A] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const canonicalCreatorId = resolveCreatorKey(LEGACY_A)!.creatorId

function video(videoId: string): RecentVideo & { topic: string | null } {
  return { videoId, title: `Title ${videoId}`, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video", viewCount: 10, topic: null }
}

function shelfPage(ids: string[]): OshiVideosPage {
  return { videos: ids.map(video), nextOffset: ids.length, hasMore: false }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  window.localStorage.setItem("yobi.locale", "en")
  fetchShelfMock.mockReset().mockResolvedValue(shelfPage(["shelf-1"]))
  fetchTopicsMock.mockReset().mockResolvedValue(TOPICS)
  fetchSearchMock.mockReset().mockResolvedValue([video("search-1")])
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const searchInput = () => document.querySelector(".oshi-videos__search input") as HTMLInputElement
const tags = () => document.querySelector(".oshi-videos__tags")
const controls = () => document.querySelector(".oshi-videos__controls") as HTMLElement

async function renderSection() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
  await flush()
  return user
}

describe("Desktop video search box drives the multilingual backend search", () => {
  it("searches the creator's indexed catalog as the user types -- debounced 250ms, no Enter and no search button", async () => {
    const user = await renderSection()
    expect(document.querySelector(".video-search-trigger")).toBeNull() // PR #118's box has no trigger / button

    await user.type(searchInput(), "minecraft")
    expect(fetchSearchMock).not.toHaveBeenCalled() // still inside the debounce window
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await flush()

    expect(fetchSearchMock).toHaveBeenCalledTimes(1)
    const [query] = fetchSearchMock.mock.calls[0]
    expect(query).toMatchObject({ creatorId: canonicalCreatorId, rawQuery: "minecraft", contentType: "all", sort: "newest", viewWindow: "total" })
    expect(query.terms).toContain("minecraft") // expanded locally from the SAME downloaded /topics catalog (title terms, never ids)
    expect(Object.keys(query)).not.toContain("topicIds")
    expect(await screen.findByText("Title search-1")).toBeInTheDocument()
    expect(screen.queryByText("Title shelf-1")).toBeNull() // the shelf shows the search result, not a local filter of the loaded list
  })

  it("keeps the Topic Tags (and the whole header) in place while searching: type -> tags still visible, backend used, clear -> normal results", async () => {
    const user = await renderSection()
    const header = document.querySelector(".oshi-videos__header") as HTMLElement
    const layout = () => Array.from(header.querySelectorAll(":scope > *, .oshi-videos__filters > *")).map((el) => el.className)
    // 1. Topic Tags are visible before typing.
    expect(tags()).not.toBeNull()
    const layoutBefore = layout()
    const tagLabels = Array.from(document.querySelectorAll(".oshi-videos__segment-item")).map((el) => el.textContent)
    expect(tagLabels.length).toBeGreaterThan(0)

    // 2. Type a search query.
    await user.type(searchInput(), "minecraft")
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await flush()

    // 3. Topic Tags are STILL visible, with the same options.
    expect(tags()).not.toBeNull()
    expect(Array.from(document.querySelectorAll(".oshi-videos__segment-item")).map((el) => el.textContent)).toEqual(tagLabels)
    // 4. The multilingual backend search is what answered.
    expect(fetchSearchMock).toHaveBeenCalledTimes(1)
    expect(fetchSearchMock.mock.calls[0][0]).toMatchObject({ creatorId: canonicalCreatorId, rawQuery: "minecraft" })
    expect(await screen.findByText("Title search-1")).toBeInTheDocument()
    // 5. No control / header element disappeared or appeared: the search box, tags and the content type + sort controls are all still there.
    expect(layout()).toEqual(layoutBefore)
    expect(searchInput()).toBeVisible()
    expect(controls().querySelectorAll("select").length).toBeGreaterThanOrEqual(2)

    // 6. Clearing the query restores the normal video result state.
    await user.clear(searchInput())
    await flush()
    expect(tags()).not.toBeNull()
    expect(layout()).toEqual(layoutBefore)
    expect(await screen.findByText("Title shelf-1")).toBeInTheDocument()
    expect(screen.queryByText("Title search-1")).toBeNull()
  })

  it("ignores the selected Topic Tag: it is never sent to the search endpoint, and a search result replaces the tag's shelf", async () => {
    const user = await renderSection()
    await user.click(screen.getByText("Minecraft"))
    await flush()
    expect(fetchShelfMock).toHaveBeenCalled()

    await user.type(searchInput(), "valorant")
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await flush()

    const [query] = fetchSearchMock.mock.calls[0]
    expect(Object.keys(query)).not.toContain("topic") // the endpoint has no tag parameter at all
    expect(query.terms).toEqual(["valo"]) // expanded from the QUERY, not from the selected Minecraft tag
    expect(await screen.findByText("Title search-1")).toBeInTheDocument()
    expect(tags()).not.toBeNull() // the tags are visible during the search too, but the search itself never uses the selected tag
  })

  it("keeps the sort control live during a search: changing it searches again with the new sort", async () => {
    const user = await renderSection()
    await user.type(searchInput(), "minecraft")
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await flush()
    fetchSearchMock.mockClear()

    const sort = screen.getByRole("combobox", { name: /sort/i })
    await user.selectOptions(sort, "mostViews")
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await flush()

    expect(fetchSearchMock).toHaveBeenCalled()
    expect(fetchSearchMock.mock.calls.at(-1)![0]).toMatchObject({ rawQuery: "minecraft", sort: "mostViews", creatorId: canonicalCreatorId })
  })

  it("shows an empty state for a search with no results", async () => {
    fetchSearchMock.mockResolvedValue([])
    const user = await renderSection()
    await user.type(searchInput(), "nothing")
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await flush()

    expect(await screen.findByText("No matching videos")).toBeInTheDocument()
  })

  it("a query below the engine's activation threshold does not search and leaves the normal shelf in place", async () => {
    const user = await renderSection()
    await user.type(searchInput(), "a")
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    await flush()

    expect(fetchSearchMock).not.toHaveBeenCalled()
    expect(tags()).not.toBeNull()
    expect(await screen.findByText("Title shelf-1")).toBeInTheDocument()
  })
})
