/** Acceptance for the Home mock -> real API cutover: the real HomePage against a stubbed `fetch`, asserting the
 * actual HTTP requests Home sends and what it renders for each response. Only the network is faked.
 *
 * Page size is read from OSHI_VIDEOS_RECENT_PAGE_SIZE (not hard-coded) so these stay true if it changes. */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./HomePage"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { OSHI_VIDEOS_RECENT_PAGE_SIZE } from "../../features/home-room/model/oshiVideosQuery"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { formatCompactCount } from "../../features/oshi-status/utils/oshiActivity"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

const PAGE = OSHI_VIDEOS_RECENT_PAGE_SIZE
const [CREATOR_A, CREATOR_B, CREATOR_C] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const LEGACY_B = toLegacyRosterId(CREATOR_B)
const SUBSCRIBERS = 654_321

interface VideoDto {
  videoId: string
  title: string
  publishedAt: string
  contentType: "upload"
  currentViewCount: number
}

/** `count` uploads for one creator + topic, newest first: ids are unique per creator/topic and carry no "mock" marker. */
function catalog(creatorId: string, topic: string, count: number, label = "Real"): VideoDto[] {
  return Array.from({ length: count }, (_, index) => ({
    videoId: `${creatorId}-${topic}-${String(index).padStart(3, "0")}`,
    title: `${label} ${creatorId} ${topic} #${index}`,
    publishedAt: new Date(Date.UTC(2026, 8, 30) - index * 3_600_000).toISOString(),
    contentType: "upload" as const,
    currentViewCount: 1000 - index,
  }))
}

interface Context {
  creatorId: string
  params: URLSearchParams
}

interface FakeApi {
  requests: string[]
  /** Replace how a creator's shelf `recent` request is answered. */
  recent: (context: Context) => Response | Promise<Response> | null
  /** Per creator -> topic -> rows the default `recent` handler pages through. */
  catalogs: Record<string, Record<string, VideoDto[]>>
  statusResponse: () => Response | Promise<Response>
  unexpected: string[]
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

function statusBody() {
  return {
    subscriberCount: SUBSCRIBERS,
    latestVideo: null,
    thisWeek: { newUploads: 2, newStreams: 1 },
    growth: {
      "1d": { absoluteGrowth: 1, videoCount: 1 },
      "7d": { absoluteGrowth: 7, videoCount: 7 },
      "30d": { absoluteGrowth: 30, videoCount: 30 },
    },
    recent: [],
    sinceLastVisit: null,
  }
}

let api: FakeApi

function installApi() {
  api = {
    requests: [],
    recent: () => null,
    catalogs: {},
    statusResponse: () => json(statusBody()),
    unexpected: [],
  }
  vi.stubEnv("VITE_API_BASE_URL", "https://api.test")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      const path = `${url.pathname}${url.search}`
      api.requests.push(path)

      if (url.pathname === "/live-streams") return json({ streams: [] })
      // Real shape (src/api/dashboard_catalog_api.py's get_topics): the tag bar's own
      // GET /topics fetch (useVideoTopicCatalog) -- "valorant"/"VALO" is the one id/label
      // this file's own tests click through the rendered tag bar.
      if (url.pathname === "/topics") {
        return json({
          topics: [
            { id: "valorant", labels: { en: "VALO" } },
            { id: "sf6", labels: { en: "SF6" } },
          ],
        })
      }

      const creatorMatch = url.pathname.match(/^\/creators\/([^/]+)\/(videos\/recent|oshi-status)$/)
      if (!creatorMatch) {
        api.unexpected.push(path)
        return json({ error: "not found" }, 404)
      }
      const creatorId = decodeURIComponent(creatorMatch[1])
      if (creatorMatch[2] === "oshi-status") return api.statusResponse()

      // The player's archive pool asks for completed livestreams; the shelf asks for liveStatus=archived.
      if (url.searchParams.get("liveStatus") === "completed") return json({ videos: [], hasMore: false })
      const custom = api.recent({ creatorId, params: url.searchParams })
      if (custom) return custom
      const rows = api.catalogs[creatorId]?.[url.searchParams.get("topic") ?? "all"] ?? []
      const offset = Number(url.searchParams.get("offset"))
      const limit = Number(url.searchParams.get("limit"))
      return json({ videos: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length })
    }),
  )
}

/** The shelf's own requests (the player pool's archive request is liveStatus=completed). */
const shelfRequests = (creatorId?: string) =>
  api.requests.filter(
    (path) => path.includes("/videos/recent?") && path.includes("liveStatus=archived") && (!creatorId || path.includes(`/creators/${creatorId}/`)),
  )
/** Every creator any request in `paths` was made for (Home's per-creator endpoints only). */
const creatorsRequested = (paths: string[]) =>
  new Set(paths.map((path) => path.match(/^\/creators\/([^/?]+)/)?.[1]).filter((id): id is string => id !== undefined))
const paramOf = (path: string, name: string) => new URL(`https://x${path}`).searchParams.get(name)
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".oshi-video-card"))
const cardTitles = () => cards().map((card) => card.querySelector(".oshi-video-card__title")?.textContent ?? "")
const viewport = () => document.querySelector<HTMLElement>(".oshi-videos__viewport")!

/** Scroll the shelf so the card at `leadingIndex` leads (jsdom has no layout: card width 0 + 10px gap). */
function scrollShelfTo(leadingIndex: number) {
  const element = viewport()
  element.scrollLeft = leadingIndex * 10
  fireEvent.scroll(element)
}

function selectCreator(legacyId: string) {
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](legacyId))
}

beforeEach(() => {
  installApi()
  selectCreator(LEGACY_A)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("Home -> real API: open", () => {
  it("currentOshi's status and the first shelf page come from the real API, for that creator only", async () => {
    api.catalogs[CREATOR_A.creatorId] = { all: catalog(CREATOR_A.creatorId, "all", 3 * PAGE) }
    render(<HomePage />)

    await waitFor(() => expect(cards()).toHaveLength(PAGE))
    expect(cardTitles()[0]).toContain(`Real ${CREATOR_A.creatorId} all #0`)
    expect(await screen.findByText(new RegExp(formatCompactCount(SUBSCRIBERS)))).toBeInTheDocument() // oshi-status

    const first = shelfRequests(CREATOR_A.creatorId)[0]
    expect(first).toContain(`/creators/${CREATOR_A.creatorId}/videos/recent?`)
    expect(paramOf(first, "offset")).toBe("0")
    expect(paramOf(first, "limit")).toBe(String(PAGE))
    expect(api.requests.some((path) => path.startsWith(`/creators/${CREATOR_A.creatorId}/oshi-status`))).toBe(true)
    expect(api.unexpected).toEqual([]) // Home calls no endpoint other than the ones above, /live-streams and /topics
    expect(creatorsRequested(api.requests)).toEqual(new Set([CREATOR_A.creatorId])) // only the current creator
  })

  it("renders no mock video anywhere", async () => {
    api.catalogs[CREATOR_A.creatorId] = { all: catalog(CREATOR_A.creatorId, "all", 5) }
    render(<HomePage />)

    await waitFor(() => expect(cards()).toHaveLength(5))
    expect(document.body.innerHTML).not.toMatch(/mock_|dQw4w9WgXcQ|【告知】新衣装/)
    // every thumbnail is the API video's own id
    const thumbnails = Array.from(document.querySelectorAll<HTMLImageElement>(".oshi-video-card img")).map((img) => img.src)
    expect(thumbnails.every((src) => src.includes(`/vi/${CREATOR_A.creatorId}-all-`))).toBe(true)
  })
})

describe("Home -> real API: Load More", () => {
  it("fetches the next page from the server's offset: the next rows append, none are duplicated", async () => {
    api.catalogs[CREATOR_A.creatorId] = { all: catalog(CREATOR_A.creatorId, "all", 2 * PAGE + 5) }
    render(<HomePage />)
    await waitFor(() => expect(cards()).toHaveLength(PAGE))

    scrollShelfTo(PAGE - 7)
    await waitFor(() => expect(cards()).toHaveLength(2 * PAGE))
    expect(paramOf(shelfRequests().at(-1)!, "offset")).toBe(String(PAGE))
    expect(cardTitles()[PAGE]).toContain(`#${PAGE}`) // the next page starts right after the first
    expect(new Set(cardTitles()).size).toBe(2 * PAGE)

    scrollShelfTo(PAGE - 7 + PAGE) // the prefetch threshold advanced by one page
    await waitFor(() => expect(cards()).toHaveLength(2 * PAGE + 5))
    expect(paramOf(shelfRequests().at(-1)!, "offset")).toBe(String(2 * PAGE))
    expect(new Set(cardTitles()).size).toBe(2 * PAGE + 5)

    // the last page said hasMore=false: scrolling further asks for nothing
    const before = shelfRequests().length
    scrollShelfTo(5 * PAGE)
    await act(async () => {})
    expect(shelfRequests()).toHaveLength(before)
  })

  it("never shows a video twice even if the backend's next page overlaps the previous one", async () => {
    const rows = catalog(CREATOR_A.creatorId, "all", 2 * PAGE)
    api.recent = ({ params }) => {
      const offset = Number(params.get("offset"))
      // page 2 repeats the last 3 rows of page 1 (the result changed between the two requests)
      const page = offset === 0 ? rows.slice(0, PAGE) : [...rows.slice(PAGE - 3, PAGE), ...rows.slice(PAGE)]
      return json({ videos: page, hasMore: offset === 0 })
    }
    render(<HomePage />)
    await waitFor(() => expect(cards()).toHaveLength(PAGE))

    scrollShelfTo(PAGE - 7)

    await waitFor(() => expect(cards()).toHaveLength(2 * PAGE))
    expect(new Set(cardTitles()).size).toBe(2 * PAGE)
    expect(cardTitles().filter((title) => title === `Real ${CREATOR_A.creatorId} all #${PAGE - 1}`)).toHaveLength(1) // an overlapped row appears once
  })
})

describe("Home -> real API: topic filter", () => {
  it("sends the topic, restarts paging at offset 0, and shows only the new topic's rows", async () => {
    api.catalogs[CREATOR_A.creatorId] = {
      all: catalog(CREATOR_A.creatorId, "all", 2 * PAGE),
      valorant: catalog(CREATOR_A.creatorId, "valorant", PAGE + 3),
    }
    const user = userEvent.setup()
    render(<HomePage />)
    await waitFor(() => expect(cards()).toHaveLength(PAGE))
    scrollShelfTo(PAGE - 7)
    await waitFor(() => expect(cards()).toHaveLength(2 * PAGE)) // paged to offset PAGE on the default shelf

    await user.click(screen.getByText("VALO"))

    await waitFor(() => expect(cardTitles().every((title) => title.includes("valorant"))).toBe(true))
    expect(cards()).toHaveLength(PAGE) // the first valorant page; none of the previous rows
    const request = shelfRequests().at(-1)!
    expect(paramOf(request, "topic")).toBe("valorant")
    expect(paramOf(request, "offset")).toBe("0") // pagination reset, not continued from the previous topic
    expect(paramOf(request, "limit")).toBe(String(PAGE))

    scrollShelfTo(PAGE - 7)
    await waitFor(() => expect(cards()).toHaveLength(PAGE + 3))
    expect(paramOf(shelfRequests().at(-1)!, "offset")).toBe(String(PAGE)) // paging continues within the NEW topic
    expect(new Set(cardTitles()).size).toBe(PAGE + 3)
  })
})

describe("Home -> real API: creator switch", () => {
  it("fetches a creator only after the user selects them; the others are never preloaded", async () => {
    api.catalogs[CREATOR_A.creatorId] = { all: catalog(CREATOR_A.creatorId, "all", PAGE) }
    api.catalogs[CREATOR_B.creatorId] = { all: catalog(CREATOR_B.creatorId, "all", 7, "Switched") }
    render(<HomePage />)
    await waitFor(() => expect(cards()).toHaveLength(PAGE))

    const beforeSwitch = [...api.requests]
    expect(creatorsRequested(beforeSwitch)).toEqual(new Set([CREATOR_A.creatorId])) // nobody else is preloaded

    selectCreator(LEGACY_B)

    await waitFor(() => expect(cardTitles()[0]).toContain(`Switched ${CREATOR_B.creatorId}`))
    expect(cards()).toHaveLength(7) // creator A's rows are gone
    expect(shelfRequests(CREATOR_B.creatorId)).toHaveLength(1)
    expect(paramOf(shelfRequests(CREATOR_B.creatorId)[0], "offset")).toBe("0")
    expect(api.requests.some((path) => path.startsWith(`/creators/${CREATOR_B.creatorId}/oshi-status`))).toBe(true)
    expect(creatorsRequested(api.requests.slice(beforeSwitch.length))).toEqual(new Set([CREATOR_B.creatorId])) // only after selecting B
    expect(api.requests.some((path) => path.includes(`/creators/${CREATOR_C.creatorId}/`))).toBe(false) // C was never selected
    expect(api.unexpected).toEqual([])
  })
})

describe("Home -> real API: reload", () => {
  it("a fresh Home fetches the real API data again (nothing is cached across loads)", async () => {
    api.catalogs[CREATOR_A.creatorId] = { all: catalog(CREATOR_A.creatorId, "all", 4, "First") }
    const first = render(<HomePage />)
    await waitFor(() => expect(cardTitles()[0]).toContain("First"))
    const statusCalls = () => api.requests.filter((path) => path.startsWith(`/creators/${CREATOR_A.creatorId}/oshi-status`)).length
    expect(shelfRequests()).toHaveLength(1)
    expect(statusCalls()).toBe(1)
    first.unmount()

    api.catalogs[CREATOR_A.creatorId] = { all: catalog(CREATOR_A.creatorId, "all", 6, "Second") }
    render(<HomePage />)

    await waitFor(() => expect(cardTitles()[0]).toContain("Second"))
    expect(cards()).toHaveLength(6)
    expect(shelfRequests()).toHaveLength(2)
    expect(statusCalls()).toBe(2)
  })
})

describe("Home -> real API: empty and failure states, never mock data", () => {
  it("an API that returns no rows renders the normal empty state, with no error and no cards", async () => {
    api.catalogs[CREATOR_A.creatorId] = { all: [] }
    render(<HomePage />)

    expect(await screen.findByText("No recent videos")).toBeInTheDocument()
    expect(cards()).toHaveLength(0)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(document.body.innerHTML).not.toMatch(/mock_|dQw4w9WgXcQ/)
  })

  it("a server error renders the normal error state (with its code), not the empty text and not mock rows", async () => {
    api.recent = () => json({ error: "Service Unavailable", code: "RANKING_NOT_READY" }, 503)
    render(<HomePage />)

    const alerts = await screen.findAllByRole("alert")
    expect(alerts.some((alert) => alert.textContent?.includes("(Code: 503)"))).toBe(true)
    expect(document.querySelector(".oshi-videos .oshi-error-state")).not.toBeNull()
    expect(screen.queryByText("No recent videos")).toBeNull()
    expect(cards()).toHaveLength(0)
    expect(document.body.innerHTML).not.toMatch(/mock_|dQw4w9WgXcQ/)
  })

  it("a network failure renders the network error state, not mock rows", async () => {
    api.recent = () => {
      throw new TypeError("Failed to fetch")
    }
    api.statusResponse = () => {
      throw new TypeError("Failed to fetch")
    }
    render(<HomePage />)

    await waitFor(() => expect(document.querySelector(".oshi-videos .oshi-error-state")).not.toBeNull())
    expect(document.querySelector(".oshi-videos .oshi-error-state")).toHaveTextContent("(Code: NETWORK)")
    expect(cards()).toHaveLength(0)
    expect(document.body.innerHTML).not.toMatch(/mock_|dQw4w9WgXcQ/)
  })

  it("a failure after the first page keeps the rows already shown and never swaps in mock data", async () => {
    const rows = catalog(CREATOR_A.creatorId, "all", 2 * PAGE)
    api.recent = ({ params }) =>
      Number(params.get("offset")) === 0 ? json({ videos: rows.slice(0, PAGE), hasMore: true }) : json({ error: "boom" }, 500)
    render(<HomePage />)
    await waitFor(() => expect(cards()).toHaveLength(PAGE))

    scrollShelfTo(PAGE - 7)
    await act(async () => {})

    await waitFor(() => expect(shelfRequests()).toHaveLength(2))
    expect(cards()).toHaveLength(PAGE)
    expect(document.body.innerHTML).not.toMatch(/mock_|dQw4w9WgXcQ/)
  })
})

describe("Home has no reachable mock-video fallback", () => {
  const sources = import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>
  const production = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$|\/test\/|\/e2e\//.test(path))

  it("no production source imports a mock video catalog or substitutes a stand-in video id", () => {
    expect(production.length).toBeGreaterThan(100)
    const offenders = production
      .filter(([, source]) => /mockRecentVideos|getRecentVideosForCreator|resolvePlaybackVideoId|dQw4w9WgXcQ|MOCK_THUMBNAIL_VIDEO_ID/.test(source))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })

  it("the Home page and its data hooks only ever read the real API (no local video catalog module exists)", () => {
    const homeModules = production.filter(([path]) => /\/(pages\/home|features\/home-room|features\/oshi-status)\//.test(path))
    const catalogs = homeModules.filter(([, source]) => /export const mock\w*Videos?\b|mockRecent|fakeVideos/i.test(source)).map(([path]) => path)

    expect(homeModules.length).toBeGreaterThan(10)
    expect(catalogs).toEqual([])
  })
})
