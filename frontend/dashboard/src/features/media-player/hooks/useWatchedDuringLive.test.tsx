import { act, render, waitFor } from "@testing-library/react"
import { useRef } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWatchedDuringLive } from "./useWatchedDuringLive"
import { loadYouTubeIframeApi, type YouTubeStateChangeEvent } from "../utils/youtubeIframeApi"

vi.mock("../utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))

const WATCHED_KEY = "yobi.newContent.watchedDuringLive"
const loadMock = vi.mocked(loadYouTubeIframeApi)

/** YT.PlayerState values the real API reports. */
const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }

interface FakePlayer {
  iframe: HTMLIFrameElement
  emit: (state: number) => void
}
let players: FakePlayer[]

beforeEach(() => {
  players = []
  loadMock.mockReset()
  loadMock.mockResolvedValue({
    PlayerState: { PLAYING: STATE.PLAYING },
    Player: class {
      constructor(iframe: HTMLIFrameElement, options: { events: { onStateChange?: (event: YouTubeStateChangeEvent) => void } }) {
        players.push({ iframe, emit: (state) => options.events.onStateChange?.({ data: state }) })
      }
    },
  })
})

const watchedIds = (): string[] => (JSON.parse(window.localStorage.getItem(WATCHED_KEY) ?? "[]") as [string, number][]).map(([id]) => id)

function Harness({ videoId, isLive }: { videoId: string; isLive: boolean | undefined }) {
  const ref = useRef<HTMLIFrameElement>(null)
  useWatchedDuringLive(ref, videoId, isLive)
  return <iframe key={videoId} ref={ref} title="player" />
}

async function mountedPlayer(videoId = "live-1", isLive: boolean | undefined = true) {
  const view = render(<Harness videoId={videoId} isLive={isLive} />)
  await waitFor(() => expect(players.length).toBeGreaterThan(0))
  return { view, player: players.at(-1)! }
}

describe("only a confirmed PLAYING callback records watched-during-live", () => {
  it("records the live videoId on the first PLAYING", async () => {
    const { player } = await mountedPlayer("live-1")

    act(() => player.emit(STATE.PLAYING))

    expect(watchedIds()).toEqual(["live-1"])
  })

  it("wraps the existing iframe -- it never creates a second player element", async () => {
    const { view, player } = await mountedPlayer()

    expect(view.container.querySelectorAll("iframe")).toHaveLength(1)
    expect(player.iframe).toBe(view.container.querySelector("iframe"))
  })

  it("records nothing when the iframe loads but PLAYING never arrives", async () => {
    await mountedPlayer()
    await act(async () => {})

    expect(watchedIds()).toEqual([])
  })

  it.each([
    ["UNSTARTED (autoplay blocked / never started)", STATE.UNSTARTED],
    ["CUED", STATE.CUED],
    ["BUFFERING", STATE.BUFFERING],
    ["PAUSED", STATE.PAUSED],
    ["ENDED", STATE.ENDED],
    ["an unknown state code", 99],
  ])("treats %s as not watched", async (_name, state) => {
    const { player } = await mountedPlayer()

    act(() => player.emit(state))

    expect(watchedIds()).toEqual([])
  })

  it("records nothing when the IFrame API cannot be loaded", async () => {
    loadMock.mockReset()
    loadMock.mockRejectedValue(new Error("blocked"))
    render(<Harness videoId="live-1" isLive />)
    await act(async () => {})

    expect(players).toEqual([])
    expect(watchedIds()).toEqual([])
  })

  it("does not even load the IFrame API when tracking is off (isLive undefined)", async () => {
    render(<Harness videoId="live-1" isLive={undefined} />)
    await act(async () => {})

    expect(loadMock).not.toHaveBeenCalled()
    expect(watchedIds()).toEqual([])
  })
})

describe("it must be live right now", () => {
  it("PLAYING on a stream that is not live (an archive or a waiting room) records nothing", async () => {
    const { player } = await mountedPlayer("archive-1", false)

    act(() => player.emit(STATE.PLAYING))

    expect(watchedIds()).toEqual([])
  })

  it("a PLAYING that arrives just before the live status flips to live is still recorded once it is live", async () => {
    const { view, player } = await mountedPlayer("live-1", false)
    act(() => player.emit(STATE.PLAYING))
    expect(watchedIds()).toEqual([])

    view.rerender(<Harness videoId="live-1" isLive />)

    expect(watchedIds()).toEqual(["live-1"])
  })

  it("stops counting once playback pauses before it goes live", async () => {
    const { view, player } = await mountedPlayer("live-1", false)
    act(() => player.emit(STATE.PLAYING))
    act(() => player.emit(STATE.PAUSED))

    view.rerender(<Harness videoId="live-1" isLive />)

    expect(watchedIds()).toEqual([])
  })

  it("playback of one video never records a different videoId", async () => {
    const { view, player } = await mountedPlayer("live-1")
    act(() => player.emit(STATE.PLAYING))

    view.rerender(<Harness videoId="live-2" isLive />)
    await waitFor(() => expect(players).toHaveLength(2))

    expect(watchedIds()).toEqual(["live-1"])

    act(() => players[0].emit(STATE.PLAYING)) // a stale callback from the previous iframe is ignored
    expect(watchedIds()).toEqual(["live-1"])

    act(() => players[1].emit(STATE.PLAYING))
    expect(watchedIds()).toEqual(["live-1", "live-2"])
  })
})
