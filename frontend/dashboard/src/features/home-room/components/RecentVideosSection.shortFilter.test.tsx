import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { buildOshiVideosRequest, type OshiVideosQuery } from "../model/oshiVideosQuery"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

// B23: the Video List's Short filter, and Short as an EXCLUSIVE category. Classification is the backend's
// (contentType=short); this file proves the filter's position/labels, the query it sends (topic tags ask for
// excludeShorts=true), and that the shelf shows exactly what the backend contract returns for those queries.

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))

const fetchMock = vi.mocked(fetchOshiVideos)
const fetchTopicsMock = vi.mocked(fetchVideoTopics)

/** The real backend taxonomy order (src/tracking/video_topics.py), with Other last, all three locales labelled. */
const TOPICS: BackendVideoTopic[] = [
  { id: "valorant", labels: { "zh-TW": "VALO", en: "VALO", ja: "VALO" } },
  { id: "sf6", labels: { "zh-TW": "SF6", en: "SF6", ja: "SF6" } },
  { id: "mv", labels: { "zh-TW": "MV", en: "MV", ja: "MV" } },
  { id: "other", labels: { "zh-TW": "其他", en: "Other", ja: "その他" } },
]

const [CREATOR_A] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)

type CatalogItem = RecentVideo & { contentType: "short" | "upload" | "live"; topic: string }
/** What the backend holds for this creator. A Short keeps its own topic internally. */
const CATALOG: CatalogItem[] = [
  { videoId: "s-valo", title: "VALO short", publishedAt: "2026-09-30T00:00:00Z", contentFormat: "shorts", viewCount: 5, contentType: "short", topic: "valorant" },
  { videoId: "s-other", title: "Other short", publishedAt: "2026-09-20T00:00:00Z", contentFormat: "shorts", viewCount: 100, contentType: "short", topic: "other" },
  { videoId: "s-mv", title: "MV short", publishedAt: "2026-09-10T00:00:00Z", contentFormat: "shorts", viewCount: 900, contentType: "short", topic: "mv" },
  { videoId: "u-valo", title: "VALO upload", publishedAt: "2026-09-26T00:00:00Z", contentFormat: "normal_video", viewCount: 50, contentType: "upload", topic: "valorant" },
  { videoId: "u-mv", title: "MV upload", publishedAt: "2026-09-25T00:00:00Z", contentFormat: "normal_video", viewCount: 60, contentType: "upload", topic: "mv" },
  { videoId: "u-other", title: "Other upload", publishedAt: "2026-09-24T00:00:00Z", contentFormat: "normal_video", viewCount: 70, contentType: "upload", topic: "other" },
  { videoId: "l-mv", title: "MV archived stream", publishedAt: "2026-09-28T00:00:00Z", contentFormat: "live_archive", viewCount: 80, contentType: "live", topic: "mv" },
  { videoId: "l-up", title: "Upcoming stream", publishedAt: "2026-09-27T00:00:00Z", contentFormat: "live_upcoming", contentType: "live", topic: "mv" },
]

/** The real endpoint's contract: topic -> contentType -> excludeShorts -> archived -> sort (upcoming/live never in an archive shelf). */
function backendLike(query: OshiVideosQuery): OshiVideosPage {
  const matches = CATALOG.filter(
    (item) =>
      (query.topic === "all" || item.topic === query.topic) &&
      (query.contentType === "all" || item.contentType === query.contentType) &&
      !(query.excludeShorts && item.contentType === "short") &&
      item.contentFormat !== "live_upcoming",
  )
  const sorted = [...matches].sort((a, b) =>
    query.sort === "mostViews" ? (b.viewCount ?? 0) - (a.viewCount ?? 0) : query.sort === "oldest" ? a.publishedAt.localeCompare(b.publishedAt) : b.publishedAt.localeCompare(a.publishedAt),
  )
  return { videos: sorted.map(({ contentType: _contentType, topic: _topic, ...video }) => video), nextOffset: sorted.length, hasMore: false }
}

type User = ReturnType<typeof userEvent.setup>
const lastQuery = (): OshiVideosQuery => fetchMock.mock.calls.at(-1)![0]
const tagLabels = () => Array.from(document.querySelectorAll(".oshi-videos__segment-label")).map((node) => node.textContent)
const cardTitles = () => Array.from(document.querySelectorAll(".oshi-video-card__title")).map((node) => node.textContent)
const sortSelect = () => screen.getByRole("combobox", { name: "Sort videos" })

async function renderWithTopics(locale: "en" | "zh-TW" | "ja" = "en") {
  window.localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
  render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
  await waitFor(() => expect(tagLabels()).toContain(locale === "ja" ? "その他" : locale === "zh-TW" ? "其他" : "Other"))
}
async function pickTag(user: User, label: string) {
  await user.click(await screen.findByText(label))
}

beforeEach(() => {
  window.localStorage.clear()
  fetchMock.mockReset().mockImplementation(async (query) => backendLike(query))
  fetchTopicsMock.mockReset().mockResolvedValue(TOPICS)
})

describe("B23: Short filter placement and labels", () => {
  it("sits immediately before Other, and every other filter keeps its order", async () => {
    await renderWithTopics("en")

    expect(tagLabels()).toEqual(["ALL", "Latest Videos", "Latest Live", "VALO", "SF6", "MV", "Short", "Other"])
  })

  it.each([
    ["zh-TW", ["ALL", "最新影片", "最新直播", "VALO", "SF6", "MV", "Short", "其他"]],
    ["en", ["ALL", "Latest Videos", "Latest Live", "VALO", "SF6", "MV", "Short", "Other"]],
    ["ja", ["ALL", "最新動画", "最新配信", "VALO", "SF6", "MV", "ショット", "その他"]],
  ] as const)("%s labels: Short is %s's exact label directly left of Other", async (locale, expected) => {
    await renderWithTopics(locale)

    expect(tagLabels()).toEqual(expected)
  })

  it("is still available (after the leading filters) before GET /topics succeeds or when it fails", async () => {
    fetchTopicsMock.mockRejectedValue(new Error("topics down"))
    window.localStorage.setItem("yobi.locale", "en")
    resetAllSharedStateForTests()
    render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(tagLabels()).toEqual(["ALL", "Latest Videos", "Latest Live", "Short"])
  })
})

describe("B23: selecting Short", () => {
  it("queries the backend classification (contentType=short, all topics, archived) and shows only Shorts, whatever their topic", async () => {
    const user = userEvent.setup()
    await renderWithTopics()
    await waitFor(() => expect(cardTitles()).toEqual(["VALO upload", "MV upload", "Other upload"])) // 最新影片: uploads only

    await pickTag(user, "Short")

    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic: "all", contentType: "short", sort: "newest", viewWindow: "total" })
    const request = buildOshiVideosRequest(lastQuery())
    expect(request.path).toContain("contentType=short")
    expect(request.path).toContain("liveStatus=archived")
    expect(request.path).not.toContain("excludeShorts")
    await waitFor(() => expect(cardTitles()).toEqual(["VALO short", "Other short", "MV short"]))
    for (const normal of ["VALO upload", "MV upload", "Other upload", "MV archived stream", "Upcoming stream"]) expect(cardTitles()).not.toContain(normal)
  })

  it("switching back to 最新影片 removes the Shorts again (uploads only, newest first)", async () => {
    const user = userEvent.setup()
    await renderWithTopics()
    await pickTag(user, "Short")
    await waitFor(() => expect(cardTitles()).toHaveLength(3))

    await pickTag(user, "Latest Videos")

    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic: "all", contentType: "upload", sort: "newest", viewWindow: "total" })
    await waitFor(() => expect(cardTitles()).toEqual(["VALO upload", "MV upload", "Other upload"]))
    expect(cardTitles().filter((title) => title?.includes("short"))).toEqual([])
  })

  it("keeps the sort control inside Short results (oldest, then most viewed via the ranking endpoint)", async () => {
    const user = userEvent.setup()
    await renderWithTopics()
    await pickTag(user, "Short")

    await user.selectOptions(sortSelect(), "oldest")
    expect(lastQuery()).toMatchObject({ topic: "all", contentType: "short", sort: "oldest" })
    await waitFor(() => expect(cardTitles()).toEqual(["MV short", "Other short", "VALO short"]))

    await user.selectOptions(sortSelect(), "mostViews")
    expect(lastQuery()).toMatchObject({ contentType: "short", sort: "mostViews" })
    expect(buildOshiVideosRequest(lastQuery()).path).toContain("/videos/ranking?")
    await waitFor(() => expect(cardTitles()).toEqual(["MV short", "Other short", "VALO short"])) // 900, 100, 5 views
  })

  it("hides the content-type dropdown (Short is a content format) but keeps the sort dropdown", async () => {
    const user = userEvent.setup()
    await renderWithTopics()
    await pickTag(user, "Short")

    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Content type"]')).toHaveStyle({ visibility: "hidden" })
    expect(sortSelect()).toBeVisible()
  })

  it("pages Short results: a next page is requested from the server's offset and appended", async () => {
    const pageOf = (from: number, count: number): RecentVideo[] =>
      Array.from({ length: count }, (_, i) => ({ videoId: `sp-${from + i}`, title: `Short ${from + i}`, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "shorts" as const }))
    fetchMock.mockImplementation(async (query, offset = 0) => {
      if (query.contentType !== "short") return { videos: [], nextOffset: 0, hasMore: false }
      return offset === 0 ? { videos: pageOf(0, 20), nextOffset: 20, hasMore: true } : { videos: pageOf(20, 5), nextOffset: 25, hasMore: false }
    })
    const user = userEvent.setup()
    await renderWithTopics()
    await pickTag(user, "Short")
    await waitFor(() => expect(cardTitles()).toHaveLength(20))

    const viewport = document.querySelector<HTMLElement>(".oshi-videos__viewport")!
    viewport.scrollLeft = 19 * 10 // jsdom has no layout: card width 0 + the 10px gap
    fireEvent.scroll(viewport)

    await waitFor(() => expect(cardTitles()).toHaveLength(25))
    const secondCall = fetchMock.mock.calls.at(-1)!
    expect(secondCall[0]).toMatchObject({ contentType: "short", topic: "all" })
    expect(secondCall[1]).toBe(20)
  })
})

describe("B23: Short is exclusive -- a topic filter lists that topic's NON-Short content", () => {
  it.each([
    ["VALO", "valorant", ["VALO upload"], "VALO short"],
    ["MV", "mv", ["MV archived stream", "MV upload"], "MV short"],
    ["Other", "other", ["Other upload"], "Other short"],
  ])("%s asks the backend for topic=%s with excludeShorts and never shows that topic's Short", async (label, topic, expected, shortTitle) => {
    const user = userEvent.setup()
    await renderWithTopics()

    await pickTag(user, label)

    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic, contentType: "all", sort: "newest", viewWindow: "total", excludeShorts: true })
    expect(buildOshiVideosRequest(lastQuery()).path).toContain("excludeShorts=true")
    await waitFor(() => expect(cardTitles()).toEqual(expected))
    expect(cardTitles()).not.toContain(shortTitle)
  })

  it("the same Short still appears under the Short filter (a stored topic is not changed)", async () => {
    const user = userEvent.setup()
    await renderWithTopics()
    await pickTag(user, "MV")
    await waitFor(() => expect(cardTitles()).not.toContain("MV short"))

    await pickTag(user, "Short")

    await waitFor(() => expect(cardTitles()).toContain("MV short"))
  })

  it("keeps the exclusion when the user changes sort or content type inside a topic", async () => {
    const user = userEvent.setup()
    await renderWithTopics()
    await pickTag(user, "MV")

    await user.selectOptions(sortSelect(), "mostViews")
    expect(lastQuery()).toMatchObject({ topic: "mv", sort: "mostViews", excludeShorts: true })
    expect(buildOshiVideosRequest(lastQuery()).path).toMatch(/\/videos\/ranking\?.*excludeShorts=true/)

    await user.selectOptions(screen.getByRole("combobox", { name: "Content type" }), "upload")
    expect(lastQuery()).toMatchObject({ topic: "mv", contentType: "upload", excludeShorts: true })
    await waitFor(() => expect(cardTitles()).toEqual(["MV upload"]))
  })

  it("ALL (the union of 最新直播 and 最新影片) also excludes Shorts: Short is its own category", async () => {
    const user = userEvent.setup()
    await renderWithTopics()

    await pickTag(user, "ALL")

    expect(lastQuery()).toEqual({ creatorId: CREATOR_A.creatorId, topic: "all", contentType: "all", sort: "newest", viewWindow: "total", excludeShorts: true })
    expect(buildOshiVideosRequest(lastQuery()).path).toContain("excludeShorts=true")
    await waitFor(() => expect(cardTitles()).toContain("MV archived stream"))
    expect(cardTitles()).toEqual(expect.arrayContaining(["VALO upload", "MV upload", "Other upload", "MV archived stream"]))
    for (const short of ["VALO short", "Other short", "MV short"]) expect(cardTitles()).not.toContain(short)
  })

  it("the Other topic keeps the content-type dropdown, and a topic page that ends on a Short does not report more", async () => {
    fetchMock.mockImplementation(async (query, offset = 0) => {
      expect(query.excludeShorts).toBe(true) // the backend counts hasMore AFTER this filter, so the UI just trusts it
      return offset === 0
        ? { videos: [{ videoId: "o1", title: "Other 1", publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video" as const }], nextOffset: 1, hasMore: false }
        : { videos: [], nextOffset: 1, hasMore: false }
    })
    const user = userEvent.setup()
    await renderWithTopics()

    await pickTag(user, "Other")

    await waitFor(() => expect(cardTitles()).toEqual(["Other 1"]))
    expect(screen.getByRole("combobox", { name: "Content type" })).toBeVisible()
    const callsBefore = fetchMock.mock.calls.length
    const viewport = document.querySelector<HTMLElement>(".oshi-videos__viewport")!
    viewport.scrollLeft = 100
    fireEvent.scroll(viewport)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchMock.mock.calls.length).toBe(callsBefore) // hasMore=false: no further page requested
  })
})

describe("B23: live badge and NEW badge in the list", () => {
  async function liveShelf(locale: "en" | "zh-TW" | "ja") {
    fetchMock.mockImplementation(async (query) =>
      query.contentType === "short"
        ? { videos: [{ videoId: "s-new", title: "Short newest", publishedAt: new Date().toISOString(), contentFormat: "shorts" }], nextOffset: 1, hasMore: false }
        : {
            videos: [
              { videoId: "live-1", title: "Live now", publishedAt: new Date().toISOString(), contentFormat: "live_now" },
              { videoId: "up-1", title: "Upcoming", publishedAt: new Date().toISOString(), contentFormat: "live_upcoming" },
              { videoId: "v-1", title: "Plain video", publishedAt: new Date().toISOString(), contentFormat: "normal_video" },
            ],
            nextOffset: 3,
            hasMore: false,
          },
    )
    await renderWithTopics(locale)
    await waitFor(() => expect(cardTitles()).toContain("Live now"))
  }
  const liveBadges = () => Array.from(document.querySelectorAll(".oshi-video-card__live-badge")).map((node) => node.textContent)

  it.each([
    ["zh-TW", "直播中"],
    ["en", "LIVE"],
    ["ja", "配信中"],
  ] as const)("a LIVE card shows exactly %s's label %s -- never 'LIVE NOW' -- on the live card only", async (locale, label) => {
    await liveShelf(locale)

    expect(liveBadges()).toEqual([label])
    const card = screen.getByRole("button", { name: /Live now/ })
    expect(card.querySelector(".oshi-video-card__live-badge")).toHaveTextContent(new RegExp(`^${label}$`))
    expect(screen.getByRole("button", { name: /Upcoming/ }).querySelector(".oshi-video-card__live-badge")).toBeNull()
  })

  it("no card in the list ever has a NEW badge (a Short included), live or not", async () => {
    const user = userEvent.setup()
    await liveShelf("zh-TW")
    expect(document.querySelector(".oshi-video-card__new-badge")).toBeNull()

    await pickTag(user, "Short")

    await waitFor(() => expect(cardTitles()).toEqual(["Short newest"]))
    expect(document.querySelector(".oshi-video-card__new-badge")).toBeNull()
    expect(document.querySelector(".oshi-video-card__live-badge")).toBeNull()
  })
})
