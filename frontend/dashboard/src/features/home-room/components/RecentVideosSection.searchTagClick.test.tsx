import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { fetchVideoSearch } from "../../video-search/data/videoSearch"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

// Clicking ANY Topic Tag while a video search is active leaves the search: the query clears (the box stays visible), the clicked tag is
// selected and its normal list shows, content type / sort stay as they were, and a pending search response can no longer land.

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

const LEGACY_A = toLegacyRosterId(getCreators()[0])

function video(videoId: string): RecentVideo & { topic: string | null } {
  return { videoId, title: `Title ${videoId}`, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video", viewCount: 10, topic: null }
}

/** Each topic's own list, so "which list is showing" is readable from the page: ALL -> "Title all-1", Minecraft -> "Title minecraft-1". */
function shelfFor(topic: string): OshiVideosPage {
  return { videos: [video(`${topic}-1`)], nextOffset: 1, hasMore: false }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  window.localStorage.setItem("yobi.locale", "en")
  fetchShelfMock.mockReset().mockImplementation(async (query) => shelfFor(query.topic))
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
const selectedTag = () => document.querySelector(".oshi-videos__segment-item.ant-segmented-item-selected")?.textContent
const controlValues = () => Array.from(document.querySelectorAll<HTMLSelectElement>(".oshi-videos__controls select")).map((select) => select.value)

async function renderSection() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
  await flush()
  return user
}

async function search(user: ReturnType<typeof userEvent.setup>, query: string) {
  await user.type(searchInput(), query)
  await act(async () => {
    vi.advanceTimersByTime(250)
  })
  await flush()
}

describe("clicking a Topic Tag while a video search is active", () => {
  it("1. clears the query, selects the clicked topic and shows that topic's normal list", async () => {
    const user = await renderSection()
    await search(user, "apex")
    expect(await screen.findByText("Title search-1")).toBeInTheDocument()

    await user.click(screen.getByText("Minecraft"))
    await flush()

    expect(searchInput().value).toBe("")
    expect(searchInput()).toBeVisible() // the box stays visible and empty
    expect(tags()).not.toBeNull()
    expect(selectedTag()).toBe("Minecraft")
    expect(await screen.findByText("Title minecraft-1")).toBeInTheDocument()
    expect(screen.queryByText("Title search-1")).toBeNull()
  })

  it("2. clicking ALL returns the normal ALL list", async () => {
    const user = await renderSection()
    await user.click(screen.getByText("Minecraft"))
    await flush()
    await search(user, "apex")
    expect(await screen.findByText("Title search-1")).toBeInTheDocument()

    await user.click(screen.getByText("ALL"))
    await flush()

    expect(searchInput().value).toBe("")
    expect(selectedTag()).toBe("ALL")
    expect(await screen.findByText("Title all-1")).toBeInTheDocument()
    expect(screen.queryByText("Title search-1")).toBeNull()
  })

  it("3. clicking the CURRENTLY selected tag still exits the search", async () => {
    const user = await renderSection()
    await user.click(screen.getByText("Minecraft"))
    await flush()
    await search(user, "apex")
    expect(await screen.findByText("Title search-1")).toBeInTheDocument()

    await user.click(screen.getByText("Minecraft")) // already selected: Segmented's own onChange does not fire for this

    await flush()
    expect(searchInput().value).toBe("")
    expect(selectedTag()).toBe("Minecraft")
    expect(await screen.findByText("Title minecraft-1")).toBeInTheDocument()
    expect(screen.queryByText("Title search-1")).toBeNull()
  })

  it("4. a pending search response is aborted and can never override the topic's list", async () => {
    let resolveSearch: (videos: Array<RecentVideo & { topic: string | null }>) => void = () => {}
    fetchSearchMock.mockImplementation(() => new Promise((resolve) => (resolveSearch = resolve)))
    const user = await renderSection()
    await search(user, "apex")
    expect(fetchSearchMock).toHaveBeenCalledTimes(1)
    const signal = fetchSearchMock.mock.calls[0][1] as AbortSignal
    expect(signal.aborted).toBe(false) // the request is still pending

    await user.click(screen.getByText("Minecraft"))
    await flush()
    expect(signal.aborted).toBe(true)

    await act(async () => resolveSearch([video("late-search")])) // the late response arrives after the tag click
    await flush()
    expect(screen.queryByText("Title late-search")).toBeNull()
    expect(await screen.findByText("Title minecraft-1")).toBeInTheDocument()
    expect(searchInput().value).toBe("")
  })

  it("5. leaves the content type / sort settings exactly as they were", async () => {
    const user = await renderSection()
    const sort = screen.getByRole("combobox", { name: /sort/i })
    await user.selectOptions(sort, "mostViews")
    await flush()
    const before = controlValues()
    expect(before).toContain("mostViews")
    await search(user, "apex")

    await user.click(screen.getByText("Minecraft"))
    await flush()

    expect(controlValues()).toEqual(before)
    expect(fetchShelfMock.mock.calls.at(-1)![0]).toMatchObject({ topic: "minecraft", sort: "mostViews" })
  })

  it("keeps the search box working after leaving: typing a new query searches again", async () => {
    const user = await renderSection()
    await search(user, "apex")
    await user.click(screen.getByText("Minecraft"))
    await flush()
    fetchSearchMock.mockClear()

    await search(user, "valorant")

    expect(fetchSearchMock).toHaveBeenCalledTimes(1)
    expect(fetchSearchMock.mock.calls[0][0]).toMatchObject({ rawQuery: "valorant" })
    expect(await screen.findByText("Title search-1")).toBeInTheDocument()
  })
})

describe("with an empty search query, Topic Tags behave exactly as before", () => {
  it("6. a tag click just selects the tag; no search request is made and the box stays empty", async () => {
    const user = await renderSection()
    expect(searchInput().value).toBe("")

    await user.click(screen.getByText("Minecraft"))
    await flush()

    expect(selectedTag()).toBe("Minecraft")
    expect(await screen.findByText("Title minecraft-1")).toBeInTheDocument()
    expect(fetchSearchMock).not.toHaveBeenCalled()
    expect(searchInput().value).toBe("")

    await user.click(screen.getByText("ALL"))
    await flush()
    expect(selectedTag()).toBe("ALL")
    expect(await screen.findByText("Title all-1")).toBeInTheDocument()
  })
})
