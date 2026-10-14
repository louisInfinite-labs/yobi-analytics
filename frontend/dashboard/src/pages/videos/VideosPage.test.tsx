import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { VideosPage } from "./VideosPage"
import { MainNavbar } from "../../app/navigation/MainNavbar"
import { goToPage } from "../../app/navigation/useCurrentPage"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { getCreators, resolveCreatorKey, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { fetchOshiVideos, type OshiVideosPage } from "../../features/home-room/data/oshiVideos"
import { fetchVideoTopics } from "../../features/home-room/data/videoTopics"
import { fetchVideoSearch } from "../../features/video-search/data/videoSearch"
import type { BackendVideoTopic } from "../../features/home-room/model/videoTopicCatalog"
import type { RecentVideo } from "../../shared/media/model/recentVideo"
import { renderHook } from "@testing-library/react"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../../features/home-room/data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../../features/home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../../features/video-search/data/videoSearch", () => ({ fetchVideoSearch: vi.fn() }))
vi.mock("../../app/navigation/useCurrentPage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/navigation/useCurrentPage")>()
  return { ...actual, goToPage: vi.fn() }
})

const fetchShelfMock = vi.mocked(fetchOshiVideos)
const fetchTopicsMock = vi.mocked(fetchVideoTopics)
const fetchSearchMock = vi.mocked(fetchVideoSearch)

const REAL_BACKEND_TOPICS: BackendVideoTopic[] = [{ id: "minecraft", labels: { en: "Minecraft" } }]
const [CREATOR_A] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const canonicalCreatorId = resolveCreatorKey(LEGACY_A)!.creatorId

function video(videoId: string, title = `Title ${videoId}`): RecentVideo & { topic: string | null } {
  return { videoId, title, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video", viewCount: 10, topic: null }
}
function shelfPage(videos: RecentVideo[]): OshiVideosPage {
  return { videos, nextOffset: videos.length, hasMore: false }
}

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  setWidth(390)
  fetchShelfMock.mockReset().mockResolvedValue(shelfPage([video("v1")]))
  fetchTopicsMock.mockReset().mockResolvedValue(REAL_BACKEND_TOPICS)
  fetchSearchMock.mockReset().mockResolvedValue([video("search-1")])
  vi.mocked(goToPage).mockClear()
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](LEGACY_A))
})

function renderPage() {
  return render(
    <>
      <MainNavbar />
      <VideosPage />
    </>,
  )
}

describe("VideosPage -- structure", () => {
  it("shares the top bar with the Drawer (hamburger) and renders Search + Filter in that same row, plus the Video List", async () => {
    renderPage()
    await flush()
    expect(document.querySelector(".main-topbar__menu")).not.toBeNull()
    expect(screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i).closest("#main-topbar-slot")).not.toBeNull()
    expect(screen.getByRole("button", { name: /filter|篩選|フィルター/i }).closest("#main-topbar-slot")).not.toBeNull()
    await screen.findByText("Title v1")
  })

  it("never renders a permanent Video Topic Segmented row on this page (Topics live inside Filter only)", async () => {
    renderPage()
    await flush()
    expect(document.querySelector(".oshi-videos__segmented")).toBeNull()
  })

  it("redirects to Home when the viewport is not mobile width", () => {
    setWidth(1280)
    renderPage()
    expect(goToPage).toHaveBeenCalledWith("home")
  })
})

describe("VideosPage -- Search", () => {
  it("autofocuses the Search input on mount", async () => {
    renderPage()
    await flush()
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i))
  })

  it("ignores the applied Video Tag once Search activates and never sends a topic to the backend", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPage()
    await flush()
    const input = screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i)
    await user.type(input, "minecraft")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchSearchMock).toHaveBeenCalledWith(expect.objectContaining({ creatorId: canonicalCreatorId, rawQuery: "minecraft" }), expect.anything())
    expect(fetchSearchMock.mock.calls[0][0]).not.toHaveProperty("topic")
    await screen.findByText("Title search-1")
  })
})

describe("VideosPage -- Filter pending/apply", () => {
  it("copies the applied state into the sheet, discards edits on Cancel, and commits them on Apply", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPage()
    await flush()
    fetchShelfMock.mockClear()

    await user.click(screen.getByRole("button", { name: /filter|篩選|フィルター/i }))
    const dialog = await screen.findByRole("dialog")
    const minecraftTile = within(dialog).getByText("Minecraft")
    await user.click(minecraftTile)

    // Not applied yet -- no new shelf request, list unchanged.
    expect(fetchShelfMock).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: /cancel|取消|キャンセル/i }))
    await flush()
    expect(fetchShelfMock).not.toHaveBeenCalled()

    // Reopen: the discarded pending edit must not have leaked through.
    await user.click(screen.getByRole("button", { name: /filter|篩選|フィルター/i }))
    const reopened = await screen.findByRole("dialog")
    await user.click(within(reopened).getByText("Minecraft"))
    await user.click(within(reopened).getByRole("button", { name: /^apply$|^套用$|^適用$/i }))
    await flush()

    expect(fetchShelfMock).toHaveBeenCalledTimes(1)
    const [appliedQuery] = fetchShelfMock.mock.calls[0]
    expect(appliedQuery.topic).toBe("minecraft")
  })
})

describe("VideosPage -- player overlay", () => {
  it("opens in place (no Home navigation), forces no autoplay, and shows no duplicate title/metadata", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPage()
    await flush()
    await screen.findByText("Title v1")

    await user.click(screen.getByText("Title v1"))
    expect(goToPage).not.toHaveBeenCalled()

    const iframe = document.querySelector("iframe") as HTMLIFrameElement
    expect(iframe.src).toContain("autoplay=0")
    // hideTitle: the modal's own title caption is suppressed (the card's title is still in the document, from the list behind it).
    expect(document.querySelector(".video-player-modal__title")).toBeNull()
    expect(screen.getByRole("button", { name: /close video player/i })).toBeInTheDocument()
  })

  it("closing the player returns to the same Videos state (query, results, list) -- never navigating away", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPage()
    await flush()
    const input = screen.getByPlaceholderText(/search this creator|搜尋這位|このVTuberの動画/i)
    await user.type(input, "minecraft")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
      await Promise.resolve()
    })
    await screen.findByText("Title search-1")

    await user.click(screen.getByText("Title search-1"))
    await user.click(screen.getByRole("button", { name: /close video player/i }))

    expect(input).toHaveValue("minecraft")
    expect(screen.getByText("Title search-1")).toBeInTheDocument()
    expect(goToPage).not.toHaveBeenCalled()
  })
})
