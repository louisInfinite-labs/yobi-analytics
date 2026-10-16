import { act, render } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useUpcomingStartRecovery } from "./useUpcomingStartRecovery"
import { useWatchedDuringLive } from "./useWatchedDuringLive"
import { loadYouTubeIframeApi } from "../utils/youtubeIframeApi"
import { RECOVERY_OFFSETS_MS } from "../utils/upcomingStartRecovery"

vi.mock("../utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))

// The scenario: an upcoming stream scheduled for 21:15 JST (12:15 UTC) is already open in Home's player, showing YouTube's waiting screen. The embed keeps its
// videoId and its iframe; only the existing player is ever asked to take that same video again, a bounded number of times, and never once it has moved on.
const START = Date.UTC(2026, 9, 16, 12, 15, 0)
const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }
const OPEN_AT = START - 10 * 60_000 // the viewer opened the stream ten minutes early

class FakePlayer {
  static instances: FakePlayer[] = []
  state = STATE.UNSTARTED
  videoId: string
  loadVideoById = vi.fn()
  cueVideoById = vi.fn()
  iframe: HTMLIFrameElement
  options: { events: { onReady?: () => void; onStateChange?: (event: { data: number }) => void } }
  constructor(iframe: HTMLIFrameElement, options: { events: { onReady?: () => void; onStateChange?: (event: { data: number }) => void } }) {
    this.iframe = iframe
    this.options = options
    this.videoId = new URL(iframe.src).pathname.split("/").pop() ?? ""
    FakePlayer.instances.push(this)
    queueMicrotask(() => options.events.onReady?.())
  }
  getPlayerState = () => this.state
  getVideoData = () => ({ video_id: this.videoId })
  /** What YouTube does on its own when the broadcast begins. */
  transition(state: number) {
    this.state = state
    this.options.events.onStateChange?.({ data: state })
  }
}

let visibility: DocumentVisibilityState = "visible"

function Embed({ videoId = "stream-1", startMs = START as number | null, autoplay = true, isLive = false }) {
  const ref = useRef<HTMLIFrameElement>(null)
  useWatchedDuringLive(ref, videoId, isLive)
  useUpcomingStartRecovery(ref, videoId, startMs, { autoplay })
  return <iframe key={videoId} ref={ref} title="player" src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1`} />
}

const player = () => FakePlayer.instances.at(-1)!
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
const calls = (p: FakePlayer) => p.loadVideoById.mock.calls.length + p.cueVideoById.mock.calls.length
const setVisibility = (value: DocumentVisibilityState) => {
  visibility = value
  act(() => void document.dispatchEvent(new Event("visibilitychange")))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(OPEN_AT)
  FakePlayer.instances = []
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
  vi.mocked(loadYouTubeIframeApi).mockResolvedValue({ Player: FakePlayer as never, PlayerState: { PLAYING: 1 } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function open(props: Parameters<typeof Embed>[0] = {}) {
  const view = render(<Embed {...props} />)
  await advance(0) // the API promise and the player's onReady
  return view
}

describe("an upcoming stream already open in the player when its scheduled start arrives", () => {
  it("does nothing at all before the scheduled start (the waiting screen is left alone)", async () => {
    await open()

    await advance(9 * 60_000)

    expect(calls(player())).toBe(0)
  })

  it("YouTube transitions to the broadcast by itself: the player is never touched, then or later", async () => {
    await open()
    await advance(10 * 60_000 + 2_000)
    act(() => player().transition(STATE.BUFFERING))
    act(() => player().transition(STATE.PLAYING))

    await advance(2 * 3_600_000)

    expect(calls(player())).toBe(0)
  })

  it("the waiting screen is still there 5 s after the start: the SAME player is asked to take the SAME video once (desktop: loadVideoById)", async () => {
    await open()

    await advance(10 * 60_000 + 5_000)

    expect(player().loadVideoById).toHaveBeenCalledTimes(1)
    expect(player().loadVideoById).toHaveBeenCalledWith("stream-1")
    expect(player().cueVideoById).not.toHaveBeenCalled()
  })

  it("phones never get an autoplay attempt: the recovery only cues the same video (the viewer taps play as before)", async () => {
    await open({ autoplay: false })

    await advance(10 * 60_000 + 5_000)

    expect(player().cueVideoById).toHaveBeenCalledWith("stream-1")
    expect(player().loadVideoById).not.toHaveBeenCalled()
  })

  it("the creator starts late: it retries at the widening, fixed offsets and the moment YouTube starts the stream it stops for good", async () => {
    await open()
    await advance(10 * 60_000 + RECOVERY_OFFSETS_MS[2] + 100) // the 5 s, 20 s and 45 s attempts
    expect(calls(player())).toBe(3)

    act(() => player().transition(STATE.PLAYING)) // the creator finally went live
    await advance(2 * 3_600_000)

    expect(calls(player())).toBe(3)
  })

  it("is bounded: a stream that never starts gets exactly one attempt per offset, never a loop", async () => {
    await open()

    await advance(10 * 60_000 + 6 * 3_600_000)

    expect(calls(player())).toBe(RECOVERY_OFFSETS_MS.length)
  })

  it("never touches a player the viewer paused", async () => {
    await open()
    act(() => player().transition(STATE.PAUSED))

    await advance(10 * 60_000 + 6 * 3_600_000)

    expect(calls(player())).toBe(0)
  })
})

describe("the embed itself is never replaced", () => {
  it("the same iframe element and src survive the whole sequence (no remount, no reload, no src change)", async () => {
    const view = await open()
    const iframe = view.container.querySelector("iframe")!
    const src = iframe.getAttribute("src")

    await advance(10 * 60_000 + 6 * 3_600_000)
    view.rerender(<Embed isLive />) // the app's own status flips to LIVE meanwhile

    expect(view.container.querySelector("iframe")).toBe(iframe)
    expect(iframe.getAttribute("src")).toBe(src)
    expect(view.container.querySelectorAll("iframe")).toHaveLength(1)
  })

  it("exactly one player is created for the iframe, even with the watched-during-live tracker observing it too", async () => {
    await open({ isLive: true })
    await advance(10 * 60_000 + 60_000)

    expect(FakePlayer.instances).toHaveLength(1)
  })

  it("makes no network request of its own", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    await open()

    await advance(10 * 60_000 + 6 * 3_600_000)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("a stream without a scheduled start (an archive) is not observed at all", async () => {
    await open({ startMs: null })
    await advance(6 * 3_600_000)

    expect(FakePlayer.instances.every((instance) => calls(instance) === 0)).toBe(true)
  })
})

describe("the viewer switches videos", () => {
  it("switching before the start removes the old watcher: the old stream's player is never asked for anything, and the new one is not touched either", async () => {
    const view = await open()
    const first = player()

    view.rerender(<Embed videoId="other-video" startMs={null} />)
    await advance(10 * 60_000 + 6 * 3_600_000)

    expect(calls(first)).toBe(0)
    expect(FakePlayer.instances.every((instance) => calls(instance) === 0)).toBe(true)
  })

  it("a player already showing a DIFFERENT video than the one the hook was created for is not touched (never forces another video)", async () => {
    await open()
    player().videoId = "something-the-viewer-picked"

    await advance(10 * 60_000 + 60_000)

    expect(calls(player())).toBe(0)
  })

  it("unmounting stops every timer and listener", async () => {
    const view = await open()
    const unmounted = player()
    view.unmount()

    await advance(10 * 60_000 + 6 * 3_600_000)
    setVisibility("visible")

    expect(calls(unmounted)).toBe(0)
  })
})

describe("a background tab", () => {
  it("does nothing while hidden, and catches up ONCE (not once per missed offset) when the viewer returns after the start", async () => {
    await open()
    setVisibility("hidden")

    await advance(10 * 60_000 + 20 * 60_000) // the start and several offsets pass while the tab is suspended
    expect(calls(player())).toBe(0)
    setVisibility("visible")

    expect(calls(player())).toBe(1)
  })

  it("returning after the player already started by itself touches nothing", async () => {
    await open()
    setVisibility("hidden")
    await advance(30 * 60_000)
    act(() => player().transition(STATE.PLAYING))

    setVisibility("visible")

    expect(calls(player())).toBe(0)
  })

  it("returning many hours later still gets its single catch-up, and then stays quiet", async () => {
    await open()
    setVisibility("hidden")
    await advance(12 * 3_600_000)
    setVisibility("visible")
    expect(calls(player())).toBe(1)

    await advance(12 * 3_600_000)

    expect(calls(player())).toBe(1)
  })
})

describe("a late mount", () => {
  it("an iframe opened right after the scheduled start is not touched while it boots (grace), and is left alone once it plays", async () => {
    vi.setSystemTime(START + 60_000)
    await open()

    await advance(14_000)
    act(() => player().transition(STATE.PLAYING))
    await advance(60 * 60_000)

    expect(calls(player())).toBe(0)
  })
})
