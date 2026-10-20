/** A video notification's deep link (/creator/<slug>?video=<id>, built by the service worker) on the REAL HomePage: the exact video is checked (YouTube
 * oEmbed, stubbed here) and opened in the central player like a deliberate pick -- also when it is in none of the Home lists -- or, when it cannot be shown,
 * the creator Home stays and a dialog explains why. Only `fetch` and the YouTube IFrame API are faked. */
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./HomePage"
import { creatorPath } from "../../app/navigation/creatorRoutes"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { loadYouTubeIframeApi } from "../../features/media-player/utils/youtubeIframeApi"
import { resetHomeSelectedVideoForTests } from "../../features/home-room/hooks/useHomeSelectedVideo"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../../features/media-player/utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))

const [CREATOR_A, CREATOR_B] = getCreators().filter((creator) => creator.active)
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const LEGACY_B = toLegacyRosterId(CREATOR_B)
const ROUTE_A = creatorPath(CREATOR_A)
const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_KEY = "yobi.newContent.seenVideoIds"
const DEFAULT_OSHI_KEY = "yobi.defaultOshiCreatorId"

const NOT_IN_LISTS = "PUBLIC00001" // a public video that is in none of the Home lists
const LIVE_NOW = "LIVENOW0001"
const UPCOMING = "UPCOMING001"
const ARCHIVE = "ARCHIVE0001"
const PRIVATE = "PRIVATE0001"
const DELETED = "DELETED0001"
const FLAKY = "FLAKY000001"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

/** Per-video oEmbed answers (a function so a test can change them between a check and its retry). */
let oembed: (videoId: string) => Response

function installApi() {
  vi.stubEnv("VITE_API_BASE_URL", "https://api.test")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") return oembed(new URL(url.searchParams.get("url") ?? "").searchParams.get("v") ?? "")
      if (url.pathname === "/live-streams") {
        return json({
          streams: [
            { videoId: LIVE_NOW, creatorId: CREATOR_A.creatorId, channelName: "c", title: "Live right now", status: "live", scheduledStart: null, actualStart: inHours(-1), thumbnailUrl: "", topic: null },
            { videoId: UPCOMING, creatorId: CREATOR_A.creatorId, channelName: "c", title: "Starting soon", status: "upcoming", scheduledStart: inHours(2), actualStart: null, thumbnailUrl: "", topic: null },
          ],
        })
      }
      if (url.pathname === "/topics") return json({ topics: [] })
      const match = url.pathname.match(/^\/creators\/([^/]+)\/(videos\/recent|oshi-status)$/)
      if (!match) return new Response("{}", { status: 404 })
      if (match[2] === "oshi-status") {
        return json({
          subscriberCount: 1,
          latestVideo: null,
          thisWeek: { newUploads: 0, newStreams: 0 },
          growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
          sinceLastVisit: null,
        })
      }
      if (url.searchParams.get("liveStatus") === "completed") return json({ videos: [], hasMore: false })
      return json({ videos: [{ videoId: "R1R1R1R1R1R", title: "Recent One", publishedAt: "2026-10-01T11:00:00Z", contentType: "upload", currentViewCount: 1 }], hasMore: false })
    }),
  )
}

const ok = (title: string) => json({ title })

beforeEach(() => {
  installApi()
  oembed = (videoId) => ok(`Title of ${videoId}`)
  vi.mocked(loadYouTubeIframeApi).mockReset()
  vi.mocked(loadYouTubeIframeApi).mockResolvedValue({ PlayerState: { PLAYING: 1 }, Player: class {} } as never)
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.localStorage.setItem(BASELINE_KEY, "2026-01-01T00:00:00.000Z")
  window.localStorage.setItem(DEFAULT_OSHI_KEY, LEGACY_B)
  resetAllSharedStateForTests()
  resetHomeSelectedVideoForTests()
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](LEGACY_A)) // what loading /creator/<slug> does: the creator shown is A, the persistent default Oshi stays B
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  window.history.replaceState({}, "", "/")
})

const playerSrc = () => document.querySelector<HTMLIFrameElement>(".oshi-player-frame iframe")?.getAttribute("src") ?? ""
const seen = () => JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]") as string[]

async function openDeepLink(search: string) {
  window.history.replaceState({}, "", `${ROUTE_A}${search}`)
  const view = render(<HomePage />)
  await screen.findByRole("button", { name: "Recent One" })
  return view
}

describe("an available video opens in the player", () => {
  it("a public video that is in none of the Home lists plays in the player, scrolls to it, and the parameter is removed", async () => {
    await openDeepLink(`?video=${NOT_IN_LISTS}`)

    await waitFor(() => expect(playerSrc()).toContain(`/embed/${NOT_IN_LISTS}?`))
    expect(window.scrollTo).toHaveBeenCalledTimes(1)
    expect(window.location.pathname + window.location.search).toBe(ROUTE_A)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("an ongoing livestream, an upcoming livestream and a completed archive are each located by their own id", async () => {
    for (const id of [LIVE_NOW, UPCOMING, ARCHIVE]) {
      window.history.replaceState({}, "", `${ROUTE_A}?video=${id}`)
      const view = render(<HomePage />)
      await waitFor(() => expect(playerSrc()).toContain(`/embed/${id}?`))
      view.unmount()
      resetHomeSelectedVideoForTests()
    }
  })

  it("opening an upload marks only that upload as seen (the existing NEW rule for a deliberate open)", async () => {
    await openDeepLink(`?video=${NOT_IN_LISTS}`)
    await waitFor(() => expect(playerSrc()).toContain(NOT_IN_LISTS))
    expect(seen()).toEqual([NOT_IN_LISTS])
  })

  it("opening a live stream does not mark it seen (a plain open is not 'watched': its archive stays NEW-eligible)", async () => {
    await openDeepLink(`?video=${LIVE_NOW}`)
    await waitFor(() => expect(playerSrc()).toContain(LIVE_NOW))
    expect(seen()).not.toContain(LIVE_NOW)
  })

  it("never changes the default Oshi", async () => {
    await openDeepLink(`?video=${NOT_IN_LISTS}`)
    await waitFor(() => expect(playerSrc()).toContain(NOT_IN_LISTS))
    expect(window.localStorage.getItem(DEFAULT_OSHI_KEY)).toBe(LEGACY_B)
  })
})

describe("a video that cannot be shown keeps the creator Home and explains", () => {
  it("private and deleted (oEmbed 404): the dialog appears, the player does not switch to it, and dismissing it leaves a usable Home", async () => {
    oembed = () => new Response("Not Found", { status: 404 })
    await openDeepLink(`?video=${PRIVATE}`)

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("This video is private or has been deleted and can't be shown.")
    expect(playerSrc()).not.toContain(PRIVATE)
    expect(window.location.pathname + window.location.search).toBe(ROUTE_A)

    await userEvent.setup().click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    await userEvent.setup().click(screen.getByRole("button", { name: "Recent One" })) // the creator Home still works
    await waitFor(() => expect(playerSrc()).toContain("R1R1R1R1R1R"))
    expect(screen.queryByRole("dialog")).toBeNull() // not shown again after normal use
  })

  it("a deleted video behaves like a private one (the same truthful message)", async () => {
    oembed = (id) => (id === DELETED ? new Response("Not Found", { status: 404 }) : ok("x"))
    await openDeepLink(`?video=${DELETED}`)
    expect(await screen.findByRole("dialog")).toHaveTextContent("private or has been deleted")
  })

  it("a video that exists but cannot be shown (oEmbed 401) gets the generic unavailable message, not a guessed reason", async () => {
    oembed = () => new Response("Unauthorized", { status: 401 })
    await openDeepLink(`?video=${PRIVATE}`)
    expect(await screen.findByRole("dialog")).toHaveTextContent("This video isn't available to watch right now.")
  })

  it("a temporary failure (5xx) is NOT reported as private: it offers Retry, and a successful retry opens the exact video", async () => {
    oembed = () => new Response("oops", { status: 503 })
    await openDeepLink(`?video=${FLAKY}`)
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("We couldn't check the video's status. Please try again later.")
    expect(dialog).not.toHaveTextContent("private")

    oembed = (id) => ok(`Title of ${id}`)
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(playerSrc()).toContain(`/embed/${FLAKY}?`))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("a network failure is a temporary failure too", async () => {
    oembed = () => {
      throw new TypeError("Failed to fetch")
    }
    await openDeepLink(`?video=${FLAKY}`)
    expect(await screen.findByRole("dialog")).toHaveTextContent("We couldn't check the video's status.")
  })
})

describe("what is left alone", () => {
  it("a creator-only notification (no video) shows the creator Home with no check and no dialog", async () => {
    await openDeepLink("")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("oembed"))).toBe(false)
  })

  it("an invalid video id is ignored: no check, no dialog, the parameter is removed", async () => {
    await openDeepLink("?video=not-valid")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("oembed"))).toBe(false)
    expect(window.location.search).toBe("")
  })

  it("refreshing after the link was consumed shows the plain creator Home (no second deep link, no dialog)", async () => {
    oembed = () => new Response("Not Found", { status: 404 })
    const first = await openDeepLink(`?video=${PRIVATE}`)
    await screen.findByRole("dialog")
    first.unmount()

    render(<HomePage />) // F5 on the now-clean URL
    await screen.findByRole("button", { name: "Recent One" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
