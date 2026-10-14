import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, resolveCreatorKey, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { fetchVideoSearch } from "../../video-search/data/videoSearch"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../../video-search/data/videoSearch", () => ({ fetchVideoSearch: vi.fn() }))

const fetchShelfMock = vi.mocked(fetchOshiVideos)
const fetchTopicsMock = vi.mocked(fetchVideoTopics)
const fetchSearchMock = vi.mocked(fetchVideoSearch)

const REAL_BACKEND_TOPICS: BackendVideoTopic[] = [
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
  fetchShelfMock.mockReset().mockResolvedValue(shelfPage(["shelf-1"]))
  fetchTopicsMock.mockReset().mockResolvedValue(REAL_BACKEND_TOPICS)
  fetchSearchMock.mockReset().mockResolvedValue([video("search-1")])
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("RecentVideosSection -- Video Search", () => {
  it("clicking the search trigger reveals the input and hides the Tag Segmented", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
    await flush()

    expect(document.querySelector(".oshi-videos__segmented")).not.toBeNull()
    await user.click(screen.getByRole("button", { name: /search|搜尋|検索/i }))
    expect(document.querySelector(".oshi-videos__segmented")).toBeNull()
    expect(screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i)).toBeInTheDocument()
  })

  it("ignores the currently selected Video Tag once Search activates, and never sends a topic to the backend", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
    await flush()

    // Select a real backend topic tag first.
    const minecraftTag = screen.getByText("Minecraft")
    await user.click(minecraftTag)
    await flush()
    expect(fetchShelfMock).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: /search|搜尋|検索/i }))
    const input = screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i)
    await user.type(input, "minecraft")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchSearchMock).toHaveBeenCalledWith(expect.objectContaining({ creatorId: canonicalCreatorId, rawQuery: "minecraft" }), expect.anything())
    const [sentQuery] = fetchSearchMock.mock.calls[0]
    expect(sentQuery).not.toHaveProperty("topic") // the selected Tag is never part of the search request
    await screen.findByText("Title search-1")
    expect(screen.queryByText("Title shelf-1")).not.toBeInTheDocument()
  })

  it("restores the remembered Video Tag's own videos once Search is cleared", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
    await flush()
    await user.click(screen.getByText("Minecraft"))
    await flush()

    await user.click(screen.getByRole("button", { name: /search|搜尋|検索/i }))
    const input = screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i)
    await user.type(input, "minecraft")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
      await Promise.resolve()
    })
    await screen.findByText("Title search-1")

    // Clearing search (the X button next to the expanded input) ends Search mode.
    await user.click(screen.getByRole("button", { name: /clear search|清除搜尋|検索をクリア/i }))
    await flush()

    expect(document.querySelector(".oshi-videos__segmented")).not.toBeNull()
    await screen.findByText("Title shelf-1")
  })

  it("keeps the content-type and sort dropdowns visible and usable while Search is active", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
    await flush()

    await user.click(screen.getByRole("button", { name: /search|搜尋|検索/i }))
    const sortSelect = screen.getByRole("combobox", { name: /sort|排序|並び/i })
    expect(sortSelect).toBeVisible()

    const input = screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i)
    await user.type(input, "minecraft")
    await user.selectOptions(sortSelect, within(sortSelect).getByText(/oldest|最舊|古い/i))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchSearchMock).toHaveBeenCalledWith(expect.objectContaining({ sort: "oldest" }), expect.anything())
  })

  it("shows the normal tag-filtered shelf (not an empty state) while below the activation threshold", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
    await flush()

    await user.click(screen.getByRole("button", { name: /search|搜尋|検索/i }))
    const input = screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i)
    await user.type(input, "ab")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(fetchSearchMock).not.toHaveBeenCalled()
    await screen.findByText("Title shelf-1")
  })
})
