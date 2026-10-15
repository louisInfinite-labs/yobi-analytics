/** The Schedule's Play/Open flow end to end: a stream card opens the detail modal (no fullscreen), tapping "Open Stream" on a touch device opens
 * the player AND asks for fullscreen from that same tap, on a desktop it opens the ordinary modal, and nothing else (page load, opening the
 * schedule, polling) ever goes fullscreen. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveSchedulePage } from "./LiveSchedulePage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import * as liveStreams from "../../shared/api/liveStreams"

vi.mock("../../shared/api/liveStreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/liveStreams")>()),
  fetchLiveStreams: vi.fn(),
}))

let fullscreenElement: Element | null
let touch: boolean
const lock = vi.fn<(orientation: string) => Promise<void>>()
const unlock = vi.fn()
const requestFullscreen = vi.fn()
const exitFullscreen = vi.fn()

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  fullscreenElement = null
  touch = true
  lock.mockReset().mockResolvedValue(undefined)
  unlock.mockReset()
  requestFullscreen.mockReset().mockImplementation(function (this: HTMLElement) {
    fullscreenElement = this
    return Promise.resolve()
  })
  exitFullscreen.mockReset().mockImplementation(async () => {
    fullscreenElement = null
  })
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement })
  Object.defineProperty(document, "exitFullscreen", { configurable: true, writable: true, value: exitFullscreen })
  Object.defineProperty(window.screen, "orientation", { configurable: true, writable: true, value: { lock, unlock } })
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, writable: true, value: requestFullscreen })
  window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)" ? touch : query === "(orientation: portrait)",
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  document.documentElement.style.overflow = ""
  document.body.style.overflow = ""
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([
    {
      videoId: "v1",
      creatorId: "aizawa_ema",
      channelName: "藍沢エマ",
      title: "Ranked grind",
      status: "live",
      scheduledStart: null,
      actualStart: new Date(2026, 8, 23, 12, 0, 0).toISOString(),
      thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
      topic: null,
    },
  ])
  // Only Date is faked (the same way the sibling page tests fix "now"): real timers keep user-event and React scheduling working.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 8, 23, 12, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
  for (const [target, key] of [
    [document, "fullscreenElement"],
    [document, "exitFullscreen"],
    [window.screen, "orientation"],
    [HTMLElement.prototype, "requestFullscreen"],
  ] as const) {
    delete (target as unknown as Record<string, unknown>)[key]
  }
})

async function openCard() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const { container } = render(<LiveSchedulePage />)
  await waitFor(() => expect(container.querySelector(".stream-avatar-button")).toBeInTheDocument())
  await user.click(container.querySelector<HTMLElement>(".stream-avatar-button")!)
  return { user, container, openButton: within(screen.getByRole("dialog")).getByRole("button", { name: "Open Stream" }) }
}

describe("nothing goes fullscreen by itself", () => {
  it("loading the schedule, polling, and opening a stream's detail modal never request fullscreen or lock the orientation", async () => {
    await openCard()

    expect(screen.getByRole("dialog")).toBeInTheDocument() // the detail modal is up
    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })
})

describe("tapping Open Stream on a touch device", () => {
  it("opens the player and asks for fullscreen from that same tap: by the time the click has been handled, with no timer or await in between", async () => {
    const { openButton } = await openCard()

    fireEvent.click(openButton)

    expect(document.querySelector(".video-player-modal__backdrop")).toBeInTheDocument()
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(requestFullscreen.mock.contexts[0]).toBe(document.querySelector(".video-player-modal__panel"))
  })

  it("then locks to landscape once fullscreen has succeeded", async () => {
    const { openButton } = await openCard()

    fireEvent.click(openButton)

    await waitFor(() => expect(lock).toHaveBeenCalledExactlyOnceWith("landscape"))
  })

  it("keeps playing in the responsive player when fullscreen is refused, and says how to get a larger view", async () => {
    requestFullscreen.mockImplementation(() => Promise.reject(new TypeError("denied")))
    const { openButton } = await openCard()

    fireEvent.click(openButton)

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Rotate your device for a larger view"))
    expect(document.querySelector(".video-player-modal__backdrop iframe")).toBeInTheDocument()
    expect(lock).not.toHaveBeenCalled()
  })

  it("closing the player (a tap on the backdrop) leaves fullscreen, unlocks the orientation and gives the page its scrolling back", async () => {
    const { user, openButton } = await openCard()
    fireEvent.click(openButton)
    await waitFor(() => expect(lock).toHaveBeenCalled())
    expect(document.documentElement.style.overflow).toBe("hidden")

    await user.click(document.querySelector<HTMLElement>(".video-player-modal__backdrop")!)

    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    expect(unlock).toHaveBeenCalled()
    expect(document.documentElement.style.overflow).toBe("")
  })

  it("the browser leaving fullscreen on its own (back gesture) unlocks the orientation and leaves the player playing", async () => {
    const { openButton } = await openCard()
    fireEvent.click(openButton)
    await waitFor(() => expect(lock).toHaveBeenCalled())
    unlock.mockClear()

    fullscreenElement = null
    document.dispatchEvent(new Event("fullscreenchange"))

    expect(unlock).toHaveBeenCalledTimes(1)
    expect(document.querySelector(".video-player-modal__backdrop iframe")).toBeInTheDocument()
  })
})

describe("tapping Open Stream on a desktop", () => {
  it("opens the ordinary player modal: no fullscreen, no orientation lock, no scroll lock", async () => {
    touch = false
    const { openButton } = await openCard()

    fireEvent.click(openButton)

    expect(document.querySelector(".video-player-modal__backdrop iframe")).toBeInTheDocument()
    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
    expect(document.documentElement.style.overflow).toBe("")
  })
})
