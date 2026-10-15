/** VideoPlayerModal's best-effort fullscreen (a touch device, opened by a tap): the request, the landscape lock after it, the rotate hint
 * when no lock could be had, and the cleanup when fullscreen is left or the player closes. Desktop is left exactly as it was. */
import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { VideoPlayerModal } from "./VideoPlayerModal"
import { readStylesheet, ruleBody } from "../../../test/readStylesheet"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

let fullscreenElement: Element | null
let touch: boolean
let portrait: boolean
let orientationListeners: Array<() => void>
const lock = vi.fn<(orientation: string) => Promise<void>>()
const unlock = vi.fn()
const requestFullscreen = vi.fn()
const exitFullscreen = vi.fn()

function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)" ? touch : query === "(orientation: portrait)" ? portrait : query === "(orientation: landscape)" ? !portrait : false,
    addEventListener: (_event: string, listener: () => void) => {
      if (query === "(orientation: landscape)") orientationListeners.push(listener)
    },
    removeEventListener: (_event: string, listener: () => void) => {
      orientationListeners = orientationListeners.filter((entry) => entry !== listener)
    },
  })) as unknown as typeof window.matchMedia
}

const fullscreenChange = () => document.dispatchEvent(new Event("fullscreenchange"))
const panel = () => document.querySelector<HTMLElement>(".video-player-modal__panel")!

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  fullscreenElement = null
  touch = true
  portrait = true
  orientationListeners = []
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
  installMatchMedia()
  document.documentElement.style.overflow = ""
  document.body.style.overflow = ""
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

const open = (props: Partial<React.ComponentProps<typeof VideoPlayerModal>> = {}) =>
  render(<VideoPlayerModal videoId="v1" title="Ranked grind" variant="player-only" fullscreenOnOpen onClose={vi.fn()} {...props} />)

describe("on a touch device, opened by a tap", () => {
  it("asks for fullscreen on the player panel while mounting (inside the opening tap), then locks to landscape", async () => {
    open()

    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(requestFullscreen.mock.contexts[0]).toBe(panel())
    expect(lock).not.toHaveBeenCalled() // only after the fullscreen promise settles
    await flush()
    expect(lock).toHaveBeenCalledExactlyOnceWith("landscape")
  })

  it("a granted landscape lock needs no hint", async () => {
    open()
    await flush()

    expect(screen.queryByRole("status")).toBeNull()
  })

  it("renders the player either way: the iframe is there before, during and after the fullscreen attempt", async () => {
    open()
    expect(document.querySelector("iframe")?.getAttribute("src")).toContain("/embed/v1")
    await flush()
    expect(document.querySelector("iframe")).toBeInTheDocument()
  })

  it.each([
    ["fullscreen unsupported", () => Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, writable: true, value: undefined })],
    ["fullscreen rejected", () => requestFullscreen.mockImplementation(() => Promise.reject(new TypeError("denied")))],
    ["orientation lock unsupported", () => Object.defineProperty(window.screen, "orientation", { configurable: true, writable: true, value: {} })],
    ["orientation lock rejected (OS rotation lock)", () => lock.mockRejectedValue(new DOMException("blocked", "NotAllowedError"))],
  ])("%s: playback still works in the responsive player and a non-blocking hint asks for a rotation", async (_name, arrange) => {
    arrange()

    open()
    await flush()

    expect(document.querySelector("iframe")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Rotate your device for a larger view")
    expect(screen.queryByRole("button")).toBeNull() // nothing to dismiss, nothing that blocks
  })

  it("no hint when the screen is already landscape", async () => {
    portrait = false
    lock.mockRejectedValue(new Error("blocked"))

    open()
    await flush()

    expect(screen.queryByRole("status")).toBeNull()
  })

  it("the hint fades on its own after a few seconds", async () => {
    vi.useFakeTimers()
    lock.mockRejectedValue(new Error("blocked"))
    open()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("status")).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_100)
    })

    expect(screen.queryByRole("status")).toBeNull()
  })

  it("the hint goes the moment the device is turned to landscape", async () => {
    lock.mockRejectedValue(new Error("blocked"))
    open()
    await flush()
    expect(screen.getByRole("status")).toBeInTheDocument()

    act(() => orientationListeners.forEach((listener) => listener()))

    expect(screen.queryByRole("status")).toBeNull()
  })

  it("does not rotate anything with CSS or touch the player's own geometry: no transform on the panel or frame", async () => {
    open()
    await flush()

    expect(panel().style.transform).toBe("")
    expect(document.querySelector<HTMLElement>(".video-player-modal__frame")!.style.transform).toBe("")
  })
})

describe("cleanup", () => {
  it("closing the player leaves fullscreen and unlocks the orientation", async () => {
    const { unmount } = open()
    await flush()
    expect(fullscreenElement).toBe(panel())

    unmount()

    expect(unlock).toHaveBeenCalled()
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
  })

  it("leaving fullscreen by the browser's own route (back gesture, Escape) unlocks the orientation and keeps the player open", async () => {
    open()
    await flush()
    unlock.mockClear()

    fullscreenElement = null
    fullscreenChange()

    expect(unlock).toHaveBeenCalledTimes(1)
    expect(document.querySelector("iframe")).toBeInTheDocument()
    expect(exitFullscreen).not.toHaveBeenCalled() // already out
  })

  it("the player handing fullscreen to its own YouTube iframe is not an exit: the landscape lock is kept", async () => {
    open()
    await flush()
    unlock.mockClear()

    fullscreenElement = document.querySelector("iframe")
    fullscreenChange()

    expect(unlock).not.toHaveBeenCalled()
  })

  it("stops listening for fullscreen changes once closed", async () => {
    const { unmount } = open()
    await flush()
    unmount()
    unlock.mockClear()

    fullscreenElement = null
    fullscreenChange()

    expect(unlock).not.toHaveBeenCalled()
  })
})

describe("no background scrolling behind the full-screen player", () => {
  it("locks the page while it is open on a touch device and restores it on close", async () => {
    const { unmount } = open()
    await flush()
    expect(document.documentElement.style.overflow).toBe("hidden")
    expect(document.body.style.overflow).toBe("") // never <body>: both together reset the page scroll

    unmount()

    expect(document.documentElement.style.overflow).toBe("")
  })
})

describe("everything else is unchanged", () => {
  it("a desktop (primary pointer is a mouse) never requests fullscreen, locks the orientation or locks scrolling: the ordinary modal", async () => {
    touch = false

    open()
    await flush()

    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
    expect(screen.queryByRole("status")).toBeNull()
    expect(document.documentElement.style.overflow).toBe("")
    expect(document.querySelector("iframe")).toBeInTheDocument()
  })

  it("a player that was not opened by the schedule's Open tap (the default) never goes fullscreen, even on a touch device", async () => {
    open({ fullscreenOnOpen: false })
    await flush()

    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
  })

  it("a re-render (a new onClose each time, as the pages pass) never asks again", async () => {
    const { rerender } = open()
    await flush()

    rerender(<VideoPlayerModal videoId="v1" title="Ranked grind" variant="player-only" fullscreenOnOpen onClose={vi.fn()} />)
    await flush()

    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(lock).toHaveBeenCalledTimes(1)
  })
})

describe("the stylesheet", () => {
  it("the rotate hint takes no taps (the video under it stays usable) and keeps clear of a home indicator", async () => {
    const body = ruleBody(await readStylesheet("src/features/dashboard/styles/dashboard.css"), ".video-player-modal__hint")

    expect(body).toMatch(/pointer-events:\s*none/)
    expect(body).toMatch(/bottom:\s*max\(16px,\s*env\(safe-area-inset-bottom\)\)/)
  })

  it("fullscreen fills the screen with dynamic viewport units and centers the largest 16:9 frame that fits (portrait and landscape)", async () => {
    const css = await readStylesheet("src/features/dashboard/styles/dashboard.css")
    const panel = ruleBody(css, ".video-player-modal__panel:fullscreen")
    const frame = ruleBody(css, ".video-player-modal__panel:fullscreen .video-player-modal__frame")

    expect(panel).toMatch(/width:\s*100vw/)
    expect(panel).toMatch(/height:\s*100vh;[\s\S]*height:\s*100dvh/)
    expect(panel).toMatch(/justify-content:\s*center/)
    expect(frame).toMatch(/width:\s*min\(100%,\s*calc\(100dvh \* 16 \/ 9\)\)/)
    expect(ruleBody(css, ".video-player-modal__panel:-webkit-full-screen")).toMatch(/width:\s*100vw/) // the prefixed engines get their own rule
  })
})
