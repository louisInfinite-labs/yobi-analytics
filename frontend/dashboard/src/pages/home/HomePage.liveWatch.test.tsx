/** Home acceptance for B19 (最新直播 = LIVE, then UPCOMING, then archives), B20 (the Oshi Status LIVE title opens the
 * stream) and watched-during-live (only a confirmed player PLAYING records it). The real HomePage runs against a stubbed
 * `fetch` and a faked YouTube IFrame API; nothing else is faked. */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./HomePage"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { OSHI_VIDEOS_RECENT_PAGE_SIZE } from "../../features/home-room/model/oshiVideosQuery"
import { loadYouTubeIframeApi, type YouTubeStateChangeEvent } from "../../features/media-player/utils/youtubeIframeApi"
import type { LiveStreamDto } from "../../shared/api/liveStreams"
import { markWatchedDuringLive } from "../../shared/newContent/newContentTracking"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../../features/media-player/utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))

const PAGE = OSHI_VIDEOS_RECENT_PAGE_SIZE
const [CREATOR_A, CREATOR_B, CREATOR_C] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const LEGACY_B = toLegacyRosterId(CREATOR_B)

const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_KEY = "yobi.newContent.seenVideoIds"
const WATCHED_KEY = "yobi.newContent.watchedDuringLive"
const STATE = { UNSTARTED: -1, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

interface ShelfRow {
  videoId: string
  title: string
  publishedAt: string
  contentType: "live" | "upload"
  currentViewCount: number
}
const row = (videoId: string, publishedAt: string, contentType: "live" | "upload" = "live"): ShelfRow => ({
  videoId,
  title: videoId,
  publishedAt,
  contentType,
  currentViewCount: 1,
})
const stream = (videoId: string, status: "live" | "upcoming", extra: Partial<LiveStreamDto> = {}): LiveStreamDto => ({
  videoId,
  creatorId: CREATOR_A.creatorId,
  channelName: "channel",
  title: videoId,
  status,
  scheduledStart: status === "upcoming" ? inHours(3) : null,
  actualStart: status === "live" ? inHours(-1) : null,
  thumbnailUrl: "",
  topic: null,
  ...extra,
})

interface FakeApi {
  streams: LiveStreamDto[]
  /** Completed-archive rows the shelf's contentType=live request pages through, per creator. */
  archives: Record<string, ShelfRow[]>
  uploads: Record<string, ShelfRow[]>
  /** The Oshi Status panel's recent rows (uploads and COMPLETED streams). */
  statusRecent: unknown[]
  requests: string[]
}
let api: FakeApi

function installApi() {
  api = { streams: [], archives: {}, uploads: {}, statusRecent: [], requests: [] }
  vi.stubEnv("VITE_API_BASE_URL", "https://api.test")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      api.requests.push(`${url.pathname}${url.search}`)
      if (url.pathname === "/live-streams") return json({ streams: api.streams })
      if (url.pathname === "/topics") return json({ topics: [{ id: "valorant", labels: { en: "VALO" } }] })

      const match = url.pathname.match(/^\/creators\/([^/]+)\/(videos\/recent|oshi-status)$/)
      if (!match) return json({ error: "not found" }, 404)
      const creatorId = decodeURIComponent(match[1])
      if (match[2] === "oshi-status") {
        return json({
          subscriberCount: 1,
          latestVideo: null,
          thisWeek: { newUploads: 0, newStreams: 0 },
          growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
          recent: api.statusRecent,
          sinceLastVisit: null,
        })
      }
      if (url.searchParams.get("liveStatus") === "completed") return json({ videos: [], hasMore: false }) // the player's own pool
      const topic = url.searchParams.get("topic") ?? "all"
      const type = url.searchParams.get("contentType")
      const byNewest = (list: ShelfRow[]) => [...list].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      const rows =
        topic !== "all"
          ? [row("TOPIC-ROW", "2026-09-01T00:00:00Z", "live")]
          : type === "all"
            ? byNewest([...(api.uploads[creatorId] ?? []), ...(api.archives[creatorId] ?? [])]) // ALL = uploads + completed livestreams
            : (type === "upload" ? api.uploads : api.archives)[creatorId] ?? []
      const offset = Number(url.searchParams.get("offset"))
      const limit = Number(url.searchParams.get("limit"))
      return json({ videos: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length })
    }),
  )
}

interface FakePlayer {
  iframe: HTMLIFrameElement
  emit: (state: number) => void
}
let players: FakePlayer[]

function installFakeYouTubeApi() {
  players = []
  vi.mocked(loadYouTubeIframeApi).mockReset()
  vi.mocked(loadYouTubeIframeApi).mockResolvedValue({
    PlayerState: { PLAYING: STATE.PLAYING },
    Player: class {
      constructor(iframe: HTMLIFrameElement, options: { events: { onStateChange?: (event: YouTubeStateChangeEvent) => void } }) {
        players.push({ iframe, emit: (state) => options.events.onStateChange?.({ data: state }) })
      }
    },
  })
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".oshi-video-card"))
const cardTitles = () => cards().map((card) => card.querySelector(".oshi-video-card__title")?.textContent ?? "")
const cardFor = (title: string) => cards().find((card) => card.querySelector(".oshi-video-card__title")?.textContent === title)!
const hasLiveBadge = (title: string) => cardFor(title).querySelector(".oshi-video-card__live-badge") !== null
const playerSrc = () => document.querySelector<HTMLIFrameElement>(".oshi-player-frame iframe")?.getAttribute("src") ?? ""
const liveTitleButton = () => document.querySelector<HTMLElement>(".oshi-status__next-title--link")
const watched = (): string[] => (JSON.parse(window.localStorage.getItem(WATCHED_KEY) ?? "[]") as [string, number][]).map(([id]) => id)
const seen = (): string[] => JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]")

function scrollShelfTo(leadingIndex: number) {
  const viewport = document.querySelector<HTMLElement>(".oshi-videos__viewport")!
  viewport.scrollLeft = leadingIndex * 10 // jsdom has no layout: card width 0 + the 10px gap
  fireEvent.scroll(viewport)
}

function selectCreator(legacyId: string) {
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](legacyId))
}

async function openLatestLive(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText(/最新直播|Latest Live/))
}

beforeEach(() => {
  installApi()
  installFakeYouTubeApi()
  window.localStorage.setItem(BASELINE_KEY, "2026-01-01T00:00:00.000Z")
  resetAllSharedStateForTests()
  selectCreator(LEGACY_A)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("B19: 最新直播 lists LIVE, then UPCOMING, then archives", () => {
  beforeEach(() => {
    api.streams = [
      stream("UP-22", "upcoming", { scheduledStart: inHours(22) }),
      stream("LIVE-NOW", "live"),
      stream("UP-21", "upcoming", { scheduledStart: inHours(21) }),
      stream("OTHER-CREATOR-LIVE", "live", { creatorId: CREATOR_C.creatorId }),
    ]
    api.archives[CREATOR_A.creatorId] = [
      row("ARC-NEWEST", "2026-10-01T20:00:00Z"),
      row("LIVE-NOW", "2026-10-01T19:30:00Z"), // a stale archive copy of the stream that is live right now
      row("ARC-OLDER", "2026-10-01T19:00:00Z"),
    ]
  })

  it("orders LIVE, then UPCOMING nearest-first, then archives newest-first, with no duplicate videoId", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)

    await waitFor(() => expect(cardTitles()).toEqual(["LIVE-NOW", "UP-21", "UP-22", "ARC-NEWEST", "ARC-OLDER"]))
    expect(new Set(cardTitles()).size).toBe(cardTitles().length)
  })

  it("the current LIVE representation wins over the stale archive copy, and another creator's stream is not listed", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)

    await waitFor(() => expect(cards().length).toBeGreaterThan(0))
    expect(hasLiveBadge("LIVE-NOW")).toBe(true)
    expect(cardTitles()).not.toContain("OTHER-CREATOR-LIVE")
  })

  it("the list never renders a NEW badge (Oshi Status owns it): LIVE shows 直播中, UPCOMING and eligible archives show none", async () => {
    window.localStorage.setItem("yobi.locale", "zh-TW")
    resetAllSharedStateForTests()
    selectCreator(LEGACY_A)
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)
    await waitFor(() => expect(cardTitles()).toContain("ARC-OLDER"))

    expect(document.querySelectorAll(".oshi-video-card__new-badge")).toHaveLength(0)
    expect(cardFor("LIVE-NOW").querySelector(".oshi-video-card__live-badge")).toHaveTextContent("直播中")
    expect(hasLiveBadge("UP-21")).toBe(false)
    expect(hasLiveBadge("UP-22")).toBe(false)
    expect(hasLiveBadge("ARC-NEWEST")).toBe(false)
    expect(cardFor("ARC-NEWEST").querySelector(".oshi-video-card__thumbnail")).not.toHaveTextContent("NEW")
  })

  it("an archive of a stream watched during its live session moves to seen; the others do not", async () => {
    markWatchedDuringLive("ARC-OLDER") // the marker a confirmed PLAYING left while that stream was live
    api.streams = []
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)
    await waitFor(() => expect(cardTitles()).toContain("ARC-OLDER"))

    // The archive was observed: the temporary marker became a permanent seen entry (and only that video did).
    await waitFor(() => expect(watched()).toEqual([]))
    expect(seen()).toEqual(["ARC-OLDER"])
  })

  it("a stream still LIVE keeps its marker -- only a completed archive migrates", async () => {
    markWatchedDuringLive("LIVE-NOW")
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)
    await waitFor(() => expect(cardTitles()).toContain("ARC-NEWEST"))

    expect(hasLiveBadge("LIVE-NOW")).toBe(true) // listed as live; its stale archive copy was dropped
    expect(watched()).toEqual(["LIVE-NOW"])
    expect(seen()).toEqual([])
  })

  it("with no LIVE or UPCOMING the archive list still works", async () => {
    api.streams = []
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)

    await waitFor(() => expect(cardTitles()).toEqual(["ARC-NEWEST", "LIVE-NOW", "ARC-OLDER"]))
  })

  it("a full archive page does not push LIVE/UPCOMING out, before or after loading the next page", async () => {
    api.archives[CREATOR_A.creatorId] = Array.from({ length: PAGE + 5 }, (_, index) =>
      row(`ARC-${String(index).padStart(2, "0")}`, new Date(Date.UTC(2026, 9, 1) - index * 3_600_000).toISOString()),
    )
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)

    await waitFor(() => expect(cards()).toHaveLength(PAGE + 3))
    expect(cardTitles().slice(0, 4)).toEqual(["LIVE-NOW", "UP-21", "UP-22", "ARC-00"])

    scrollShelfTo(PAGE - 7)
    await waitFor(() => expect(cards()).toHaveLength(PAGE + 5 + 3))
    expect(cardTitles().slice(0, 4)).toEqual(["LIVE-NOW", "UP-21", "UP-22", "ARC-00"])
  })

  it("the topic tags are untouched: they list the backend's rows only, with no LIVE/UPCOMING merged in", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await user.click(await screen.findByText("VALO"))

    await waitFor(() => expect(cardTitles()).toEqual(["TOPIC-ROW"]))
    expect(api.requests.some((path) => path.includes("topic=valorant"))).toBe(true)
  })

  it("clicking a live or upcoming card opens that exact stream without counting it as opened; an archive does count", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await openLatestLive(user)
    await waitFor(() => expect(cardTitles()).toContain("ARC-NEWEST"))

    await user.click(cardFor("UP-22"))
    expect(playerSrc()).toContain("/embed/UP-22")
    await user.click(cardFor("LIVE-NOW"))
    expect(playerSrc()).toContain("/embed/LIVE-NOW")
    expect(seen()).toEqual([])
    expect(watched()).toEqual([])

    await user.click(cardFor("ARC-NEWEST"))
    expect(playerSrc()).toContain("/embed/ARC-NEWEST")
    expect(seen()).toEqual(["ARC-NEWEST"])
  })
})

describe("B20: the Oshi Status LIVE title opens that stream", () => {
  beforeEach(() => {
    api.streams = [stream("LIVE-NOW", "live", { title: "Live right now" })]
    api.uploads[CREATOR_A.creatorId] = [row("UPLOAD-1", "2026-10-01T10:00:00Z", "upload")]
  })

  it("is an interactive button for a LIVE creator, with the live stream's own title", async () => {
    render(<HomePage />)
    await waitFor(() => expect(liveTitleButton()).not.toBeNull())

    expect(liveTitleButton()!.tagName).toBe("BUTTON")
    expect(liveTitleButton()).toHaveTextContent("Live right now")
  })

  it("clicking it selects the exact live videoId in the existing player, with no trip through 最近直播", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await user.click(await screen.findByRole("button", { name: /UPLOAD-1/ }))
    expect(playerSrc()).toContain("/embed/UPLOAD-1")
    const shelfRequestsBefore = api.requests.filter((path) => path.includes("contentType=live")).length

    await user.click(liveTitleButton()!)

    expect(playerSrc()).toContain("/embed/LIVE-NOW")
    expect(document.querySelectorAll(".oshi-player-frame iframe")).toHaveLength(1) // the one existing player, no second one
    expect(api.requests.filter((path) => path.includes("contentType=live"))).toHaveLength(shelfRequestsBefore) // the 最新直播 tag was never opened
  })

  it("is keyboard accessible: focus, then Enter or Space activates it", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await user.click(await screen.findByRole("button", { name: /UPLOAD-1/ }))
    expect(playerSrc()).toContain("/embed/UPLOAD-1")

    await waitFor(() => expect(liveTitleButton()).not.toBeNull())
    liveTitleButton()!.focus()
    expect(liveTitleButton()).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(playerSrc()).toContain("/embed/LIVE-NOW")

    await user.click(await screen.findByRole("button", { name: /UPLOAD-1/ }))
    expect(playerSrc()).toContain("/embed/UPLOAD-1")
    liveTitleButton()!.focus()
    await user.keyboard(" ")
    expect(playerSrc()).toContain("/embed/LIVE-NOW")
  })

  it("renders no link for a creator with no current live stream", async () => {
    api.streams = []
    render(<HomePage />)
    await screen.findByRole("button", { name: /UPLOAD-1/ })

    expect(liveTitleButton()).toBeNull()
  })

  it("an UPCOMING title is a button too: mouse and keyboard select its exact videoId in the existing player", async () => {
    api.streams = [stream("UP-1", "upcoming", { title: "Upcoming soon", scheduledStart: inHours(5) })]
    const user = userEvent.setup()
    render(<HomePage />)
    await user.click(await screen.findByRole("button", { name: /UPLOAD-1/ }))
    expect(playerSrc()).toContain("/embed/UPLOAD-1")

    await waitFor(() => expect(liveTitleButton()).not.toBeNull())
    expect(liveTitleButton()!.tagName).toBe("BUTTON")
    expect(liveTitleButton()).toHaveTextContent("Upcoming soon")
    await user.click(liveTitleButton()!)
    expect(playerSrc()).toContain("/embed/UP-1")
    expect(document.querySelectorAll(".oshi-player-frame iframe")).toHaveLength(1)

    await user.click(await screen.findByRole("button", { name: /UPLOAD-1/ }))
    expect(playerSrc()).toContain("/embed/UPLOAD-1")
    liveTitleButton()!.focus()
    await user.keyboard("{Enter}")
    expect(playerSrc()).toContain("/embed/UP-1")
  })

  it("clicking an UPCOMING title records nothing either: no watched marker and not opened", async () => {
    api.streams = [stream("UP-1", "upcoming", { title: "Upcoming soon", scheduledStart: inHours(5) })]
    const user = userEvent.setup()
    render(<HomePage />)
    await waitFor(() => expect(liveTitleButton()).not.toBeNull())

    await user.click(liveTitleButton()!)

    expect(playerSrc()).toContain("/embed/UP-1")
    expect(watched()).toEqual([])
    expect(seen()).not.toContain("UP-1")
  })

  it("clicking the title alone records nothing: not watched, and not opened either", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await waitFor(() => expect(liveTitleButton()).not.toBeNull())

    await user.click(liveTitleButton()!)

    expect(watched()).toEqual([])
    expect(seen()).not.toContain("LIVE-NOW")
  })

  it("after the player confirms PLAYING, the existing logic records watched-during-live", async () => {
    const user = userEvent.setup()
    render(<HomePage />)
    await waitFor(() => expect(liveTitleButton()).not.toBeNull())
    await user.click(liveTitleButton()!)
    expect(watched()).toEqual([])

    await waitFor(() => expect(players.length).toBeGreaterThan(0))
    act(() => players.at(-1)!.emit(STATE.PLAYING))

    expect(watched()).toEqual(["LIVE-NOW"])
  })
})

describe("ALL = the union of 最新直播 and 最新影片 content", () => {
  beforeEach(() => {
    api.streams = [stream("LIVE-NOW", "live"), stream("UP-21", "upcoming", { scheduledStart: inHours(21) }), stream("UP-5", "upcoming", { scheduledStart: inHours(5) })]
    api.archives[CREATOR_A.creatorId] = [row("ARC-1", "2026-10-01T20:00:00Z"), row("ARC-2", "2026-10-01T18:00:00Z")]
    api.uploads[CREATOR_A.creatorId] = [row("UPLOAD-2", "2026-10-01T21:00:00Z", "upload"), row("UPLOAD-1", "2026-10-01T19:00:00Z", "upload")]
  })
  const openAll = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<HomePage />)
    await user.click(await screen.findByText("ALL"))
  }

  it("lists the current LIVE, then UPCOMING nearest-first, then uploads and completed livestreams merged newest-first", async () => {
    const user = userEvent.setup()
    await openAll(user)

    await waitFor(() => expect(cardTitles()).toEqual(["LIVE-NOW", "UP-5", "UP-21", "UPLOAD-2", "ARC-1", "UPLOAD-1", "ARC-2"]))
    expect(new Set(cardTitles()).size).toBe(cardTitles().length)
    expect(hasLiveBadge("LIVE-NOW")).toBe(true)
  })

  it("asks the backend for every content type with Shorts excluded (Short is its own filter), not for only uploads or only livestreams", async () => {
    const user = userEvent.setup()
    await openAll(user)
    await waitFor(() => expect(cardTitles()).toContain("ARC-2"))

    const allRequest = api.requests.filter((path) => path.includes("/videos/recent") && path.includes("topic=all") && path.includes("contentType=all"))
    expect(allRequest.length).toBeGreaterThan(0)
    expect(allRequest.every((path) => path.includes("excludeShorts=true") && path.includes("liveStatus=archived"))).toBe(true)
    expect(allRequest.some((path) => path.includes("contentType=upload") || path.includes("contentType=short"))).toBe(false)
  })

  it("is no longer the union once the user narrows or re-sorts it: Videos shows no streams, oldest-first shows no current stream", async () => {
    const user = userEvent.setup()
    await openAll(user)
    await waitFor(() => expect(cardTitles()).toContain("LIVE-NOW"))

    await user.selectOptions(await screen.findByRole("combobox", { name: /Content type|內容類型/ }), "upload")
    await waitFor(() => expect(cardTitles()).toEqual(["UPLOAD-2", "UPLOAD-1"]))

    await user.selectOptions(screen.getByRole("combobox", { name: /Content type|內容類型/ }), "all")
    await user.selectOptions(screen.getByRole("combobox", { name: /Sort videos|排序/ }), "oldest")
    await waitFor(() => expect(cardTitles()).not.toContain("LIVE-NOW"))
    expect(cardTitles()).not.toContain("UP-5")
  })
})

describe("watched live -> archive: Oshi Status migrates too", () => {
  it("a completed livestream row for a stream watched while live moves it into seen and removes the marker", async () => {
    markWatchedDuringLive("DONE-STREAM")
    markWatchedDuringLive("STILL-LIVE")
    api.statusRecent = [
      { videoId: "DONE-STREAM", kind: "livestream", title: "Finished stream", thumbnailUrl: null, publishedAt: "2026-10-01T10:00:00Z", currentViewCount: 1 },
      { videoId: "UPLOAD-X", kind: "upload", title: "An upload", thumbnailUrl: null, publishedAt: "2026-10-01T11:00:00Z", currentViewCount: 1 },
    ]
    render(<HomePage />)

    await waitFor(() => expect(watched()).toEqual(["STILL-LIVE"]))
    expect(seen()).toEqual(["DONE-STREAM"]) // the upload row carries no marker, so it is untouched
  })
})

describe("watched during live: Home's player", () => {
  it("main Oshi is live on page load: the first PLAYING records it", async () => {
    api.streams = [stream("LIVE-NOW", "live")]
    render(<HomePage />)
    await waitFor(() => expect(players).toHaveLength(1))
    expect(playerSrc()).toContain("/embed/LIVE-NOW")
    expect(playerSrc()).toContain("enablejsapi=1")
    expect(watched()).toEqual([]) // the page opened, the creator was auto-selected, the iframe exists: still nothing

    act(() => players[0].emit(STATE.PLAYING))

    expect(watched()).toEqual(["LIVE-NOW"])
  })

  it("the iframe loads but PLAYING never arrives: not watched", async () => {
    api.streams = [stream("LIVE-NOW", "live")]
    render(<HomePage />)
    await waitFor(() => expect(players).toHaveLength(1))
    await act(async () => {})

    expect(watched()).toEqual([])
  })

  it.each([
    ["autoplay blocked (UNSTARTED)", STATE.UNSTARTED],
    ["CUED", STATE.CUED],
    ["BUFFERING", STATE.BUFFERING],
    ["PAUSED", STATE.PAUSED],
    ["an unknown state", 42],
  ])("%s is not watched", async (_name, state) => {
    api.streams = [stream("LIVE-NOW", "live")]
    render(<HomePage />)
    await waitFor(() => expect(players).toHaveLength(1))

    act(() => players[0].emit(state))

    expect(watched()).toEqual([])
  })

  it("an unavailable IFrame API means nothing is ever recorded", async () => {
    vi.mocked(loadYouTubeIframeApi).mockReset()
    vi.mocked(loadYouTubeIframeApi).mockRejectedValue(new Error("blocked"))
    api.streams = [stream("LIVE-NOW", "live")]
    render(<HomePage />)
    await waitFor(() => expect(playerSrc()).toContain("/embed/LIVE-NOW"))
    await act(async () => {})

    expect(players).toEqual([])
    expect(watched()).toEqual([])
  })

  it("switching the Live Status creator to a live one: PLAYING records that creator's videoId", async () => {
    api.streams = [stream("LIVE-B", "live", { creatorId: CREATOR_B.creatorId })]
    render(<HomePage />)
    await act(async () => {})
    expect(players).toHaveLength(0) // creator A is offline: no player at all

    selectCreator(LEGACY_B)
    await waitFor(() => expect(players).toHaveLength(1))
    expect(watched()).toEqual([])
    act(() => players[0].emit(STATE.PLAYING))

    expect(watched()).toEqual(["LIVE-B"])
  })

  it("switching the Live Status creator but playback never starting records nothing", async () => {
    api.streams = [stream("LIVE-B", "live", { creatorId: CREATOR_B.creatorId })]
    render(<HomePage />)
    await act(async () => {})

    selectCreator(LEGACY_B)
    await waitFor(() => expect(players).toHaveLength(1))
    act(() => players[0].emit(STATE.UNSTARTED))

    expect(watched()).toEqual([])
  })

  it("PLAYING on an upcoming stream's waiting room is not watched-during-live", async () => {
    api.streams = [stream("UP-1", "upcoming", { scheduledStart: inHours(5) })]
    render(<HomePage />)
    await waitFor(() => expect(players).toHaveLength(1))

    act(() => players[0].emit(STATE.PLAYING))

    expect(watched()).toEqual([])
  })

  it("watching one live video does not mark another", async () => {
    api.streams = [stream("LIVE-A", "live"), stream("LIVE-B", "live", { creatorId: CREATOR_B.creatorId })]
    render(<HomePage />)
    await waitFor(() => expect(players).toHaveLength(1))

    act(() => players[0].emit(STATE.PLAYING))

    expect(watched()).toEqual(["LIVE-A"])
  })
})
