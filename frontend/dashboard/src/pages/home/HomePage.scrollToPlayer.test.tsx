/** A deliberate video pick (a shelf card, or any Oshi Status title/thumbnail -- Now Playing, Live/Next, Recent Activity) takes the viewer
 * straight back to the Home player: immediately, and below the phone's sticky top bar. Nothing automatic may move the page. The real
 * HomePage runs against a stubbed `fetch`; only the YouTube IFrame API and window.scrollTo are faked. */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./HomePage"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { selectHomeVideo } from "../../features/home-room/hooks/useHomeSelectedVideo"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { loadYouTubeIframeApi } from "../../features/media-player/utils/youtubeIframeApi"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../../features/media-player/utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))

const [CREATOR_A, CREATOR_B] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const LEGACY_B = toLegacyRosterId(CREATOR_B)
const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

function installApi() {
  vi.stubEnv("VITE_API_BASE_URL", "https://api.test")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === "/live-streams") {
        return json({
          streams: [
            { videoId: "LIVE1", creatorId: CREATOR_A.creatorId, channelName: "c", title: "Live right now", status: "live", scheduledStart: null, actualStart: inHours(-1), thumbnailUrl: "", topic: null },
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
          recent: [{ videoId: "R1", kind: "upload", title: "Recent One", thumbnailUrl: null, publishedAt: "2026-10-01T11:00:00Z", currentViewCount: 1 }],
          sinceLastVisit: null,
        })
      }
      if (url.searchParams.get("liveStatus") === "completed") return json({ videos: [], hasMore: false })
      return json({ videos: [{ videoId: "U1", title: "Shelf Upload", publishedAt: "2026-10-01T00:00:00Z", contentType: "upload", currentViewCount: 1 }], hasMore: false })
    }),
  )
}

function selectCreator(legacyId: string) {
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](legacyId))
}

const playerSrc = () => document.querySelector<HTMLIFrameElement>(".oshi-player-frame iframe")?.getAttribute("src") ?? ""
const query = (selector: string) => () => document.querySelector<HTMLElement>(selector)!

const ENTRY_POINTS: [string, () => HTMLElement][] = [
  ["a shelf card", () => screen.getByText("Shelf Upload").closest("button") as HTMLElement],
  ["a Recent Activity title", () => screen.getByRole("button", { name: "Recent One" })],
  ["a Recent Activity thumbnail", () => screen.getByRole("button", { name: "Thumbnail: Recent One" })],
  ["the Now Playing title", query(".oshi-status__now-playing-title--link")],
  ["the Now Playing thumbnail", query(".oshi-status__now-playing .oshi-status__thumb")],
  ["the Live title", query(".oshi-status__next-title--link")],
  ["the Live thumbnail", query(".oshi-status__next .oshi-status__thumb")],
]

let scrollTo: ReturnType<typeof vi.spyOn>
const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, "scrollY")

beforeEach(() => {
  installApi()
  vi.mocked(loadYouTubeIframeApi).mockReset()
  vi.mocked(loadYouTubeIframeApi).mockResolvedValue({ PlayerState: { PLAYING: 1 }, Player: class {} } as never)
  window.localStorage.setItem(BASELINE_KEY, "2026-01-01T00:00:00.000Z")
  resetAllSharedStateForTests()
  selectCreator(LEGACY_A)
  scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  scrollTo.mockRestore()
  document.documentElement.style.removeProperty("--main-topbar-height")
  if (scrollYDescriptor) Object.defineProperty(window, "scrollY", scrollYDescriptor)
})

async function renderHome() {
  render(<HomePage />)
  await screen.findByRole("button", { name: "Recent One" })
  await screen.findByText("Shelf Upload")
  await waitFor(() => expect(document.querySelector(".oshi-status__next-title--link")).not.toBeNull())
}

describe("a deliberate pick returns to the player", () => {
  it.each(ENTRY_POINTS)("%s scrolls to the player once, immediately (never an animated scroll)", async (_name, entry) => {
    await renderHome()
    expect(scrollTo).not.toHaveBeenCalled() // loading the page moved nothing

    await userEvent.setup().click(entry())

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" })
  })

  it("the Now Playing title and thumbnail run the same selection as every other entry point (the playing video is selected)", async () => {
    await renderHome()
    const user = userEvent.setup()
    const before = playerSrc()

    await user.click(query(".oshi-status__now-playing-title--link")())
    await user.click(query(".oshi-status__now-playing .oshi-status__thumb")())

    expect(playerSrc()).toBe(before) // it is the video already playing: re-selecting it changes nothing but brings the player into view
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })

  it("aims below the phone's sticky top bar: the player's page position minus --main-topbar-height", async () => {
    await renderHome()
    document.documentElement.style.setProperty("--main-topbar-height", "48px")
    Object.defineProperty(window, "scrollY", { configurable: true, value: 100 })
    vi.spyOn(document.querySelector(".oshi-stream") as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 600 } as DOMRect)

    await userEvent.setup().click(screen.getByRole("button", { name: "Recent One" }))

    expect(scrollTo).toHaveBeenCalledWith({ top: 652, left: 0, behavior: "instant" }) // 600 + 100 - 48
  })

  it("has no top-bar offset where there is no sticky top bar (tablet and desktop)", async () => {
    await renderHome()
    Object.defineProperty(window, "scrollY", { configurable: true, value: 100 })
    vi.spyOn(document.querySelector(".oshi-stream") as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 600 } as DOMRect)

    await userEvent.setup().click(screen.getByRole("button", { name: "Recent One" }))

    expect(scrollTo).toHaveBeenCalledWith({ top: 700, left: 0, behavior: "instant" })
  })

  it("never scrolls to a negative position", async () => {
    await renderHome()
    document.documentElement.style.setProperty("--main-topbar-height", "48px")
    vi.spyOn(document.querySelector(".oshi-stream") as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 10 } as DOMRect)

    await userEvent.setup().click(screen.getByRole("button", { name: "Recent One" }))

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" })
  })
})

describe("nothing automatic moves the page", () => {
  it("the initial selection, data loading and polling never scroll", async () => {
    await renderHome()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("a creator change (which re-selects the player's auto video) never scrolls", async () => {
    await renderHome()

    selectCreator(LEGACY_B)
    await waitFor(() => expect(document.querySelector(".oshi-status__creator-name")?.textContent).not.toBe(""))

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("a selection that is not a Home pick (Live Status's own path, a programmatic one) changes the player but does not scroll", async () => {
    await renderHome()

    act(() => selectHomeVideo({ videoId: "OTHER1", title: "Other" }, LEGACY_A, { countsAsOpened: false }))

    await waitFor(() => expect(playerSrc()).toContain("OTHER1"))
    expect(scrollTo).not.toHaveBeenCalled() // the scroll is part of the click path, never an effect on the selected-video state
  })

  it("the mouse and keyboard reach the same control: Enter on the Now Playing thumbnail runs the same pick", async () => {
    await renderHome()
    const thumb = query(".oshi-status__now-playing .oshi-status__thumb")()
    thumb.focus()

    await userEvent.setup().keyboard("{Enter}")
    fireEvent.keyUp(thumb)

    expect(scrollTo).toHaveBeenCalledTimes(1)
  })
})
