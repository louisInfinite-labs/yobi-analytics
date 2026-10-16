import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveEmbedPlayer } from "./HomePage"
import { loadYouTubeIframeApi } from "../../features/media-player/utils/youtubeIframeApi"
import { useLiveStreams } from "../../shared/api/hooks/useLiveStreams"

// Home's real player component, wired the way Home wires it: the scheduled start comes from the shared /live-streams data, the embed keeps its iframe and
// videoId, and a waiting screen that is still there when the broadcast should have begun is nudged through the player -- never by reloading anything.

vi.mock("../../features/media-player/utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))
vi.mock("../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

const START = Date.UTC(2026, 9, 16, 12, 15, 0) // 21:15 JST

class FakePlayer {
  static instances: FakePlayer[] = []
  state = -1
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
}

const stream = (videoId: string, status: "upcoming" | "live", scheduledStart: string | null) => ({
  videoId,
  creatorId: "aizawa_ema",
  channelName: "Ema",
  title: videoId,
  status,
  scheduledStart,
  actualStart: null,
  thumbnailUrl: "",
  topic: null,
})
const mockStreams = (streams: ReturnType<typeof stream>[]) => vi.mocked(useLiveStreams).mockReturnValue({ streams, isLoading: false, error: null })
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
const calls = (p: FakePlayer) => p.loadVideoById.mock.calls.length + p.cueVideoById.mock.calls.length

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START - 10 * 60_000)
  FakePlayer.instances = []
  vi.mocked(loadYouTubeIframeApi).mockResolvedValue({ Player: FakePlayer as never, PlayerState: { PLAYING: 1 } })
  mockStreams([stream("upcoming-1", "upcoming", new Date(START).toISOString())])
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("Home's player: an upcoming stream open before its scheduled start", () => {
  it("keeps the exact upcoming videoId in one iframe and one player, and does not reload it when the start time passes", async () => {
    const view = render(<LiveEmbedPlayer videoId="upcoming-1" title="t" autoplay isLive={false} />)
    await advance(0)
    const iframe = view.container.querySelector("iframe")!
    const src = iframe.getAttribute("src")

    await advance(10 * 60_000 + 6 * 3_600_000)

    expect(src).toContain("/embed/upcoming-1?")
    expect(view.container.querySelectorAll("iframe")).toHaveLength(1)
    expect(view.container.querySelector("iframe")).toBe(iframe)
    expect(iframe.getAttribute("src")).toBe(src)
    expect(FakePlayer.instances).toHaveLength(1)
  })

  it("a waiting screen still showing at the scheduled time is asked ONCE to take the same video (desktop); at most one attempt per fixed offset afterwards", async () => {
    render(<LiveEmbedPlayer videoId="upcoming-1" title="t" autoplay isLive={false} />)
    await advance(0)

    await advance(10 * 60_000 + 5_000)
    expect(FakePlayer.instances[0].loadVideoById).toHaveBeenCalledExactlyOnceWith("upcoming-1")

    await advance(6 * 3_600_000)
    expect(calls(FakePlayer.instances[0])).toBeLessThanOrEqual(10)
  })

  it("on a phone (no autoplay) the same moment only cues the video -- never an autoplay attempt", async () => {
    render(<LiveEmbedPlayer videoId="upcoming-1" title="t" autoplay={false} isLive={false} />)
    await advance(0)

    await advance(10 * 60_000 + 5_000)

    expect(FakePlayer.instances[0].cueVideoById).toHaveBeenCalledWith("upcoming-1")
    expect(FakePlayer.instances[0].loadVideoById).not.toHaveBeenCalled()
  })

  it("a stream that is not in the live data (an archive the viewer picked) is never nudged", async () => {
    mockStreams([])
    render(<LiveEmbedPlayer videoId="archive-1" title="t" autoplay isLive={false} />)
    await advance(0)

    await advance(6 * 3_600_000)

    expect(FakePlayer.instances.every((player) => calls(player) === 0)).toBe(true)
  })

  it("the snapshot flipping the stream to live mid-wait does not remount, re-source or duplicate the player", async () => {
    const view = render(<LiveEmbedPlayer videoId="upcoming-1" title="t" autoplay isLive={false} />)
    await advance(0)
    const iframe = view.container.querySelector("iframe")!

    mockStreams([stream("upcoming-1", "live", new Date(START).toISOString())])
    view.rerender(<LiveEmbedPlayer videoId="upcoming-1" title="t" autoplay isLive />)
    await advance(10 * 60_000 + 60_000)

    expect(view.container.querySelector("iframe")).toBe(iframe)
    expect(FakePlayer.instances).toHaveLength(1)
  })

  it("the viewer picking another video before the start: the old stream is never touched afterwards", async () => {
    const view = render(<LiveEmbedPlayer videoId="upcoming-1" title="t" autoplay isLive={false} />)
    await advance(0)
    const first = FakePlayer.instances[0]

    view.rerender(<LiveEmbedPlayer videoId="picked-archive" title="t2" autoplay isLive={false} />)
    await advance(10 * 60_000 + 6 * 3_600_000)

    expect(calls(first)).toBe(0)
    expect(view.container.querySelector("iframe")!.getAttribute("src")).toContain("/embed/picked-archive?")
  })
})
