/** The fullscreen/orientation helper: what it asks for, in which order, and that no refusal ever escapes. The browser APIs are faked on the
 * real jsdom document and screen (jsdom has neither), then removed again. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { currentFullscreenElement, enterFullscreenPlayback, isTouchDevice, leaveFullscreenPlayback, unlockOrientation } from "./fullscreenPlayback"

let fullscreenElement: Element | null
const lock = vi.fn<(orientation: string) => Promise<void>>()
const unlock = vi.fn()

function stubMatchMedia(coarse: boolean) {
  window.matchMedia = ((query: string) => ({ matches: query === "(pointer: coarse)" && coarse, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
}

function defineOnce(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
}

beforeEach(() => {
  fullscreenElement = null
  lock.mockReset().mockResolvedValue(undefined)
  unlock.mockReset()
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement })
  defineOnce(document, "exitFullscreen", vi.fn(async () => void (fullscreenElement = null)))
  defineOnce(screen, "orientation", { lock, unlock })
  defineOnce(HTMLElement.prototype, "requestFullscreen", vi.fn(function (this: HTMLElement) {
    fullscreenElement = this
    return Promise.resolve()
  }))
  stubMatchMedia(true)
})

afterEach(() => {
  for (const [target, key] of [
    [document, "fullscreenElement"],
    [document, "exitFullscreen"],
    [screen, "orientation"],
    [HTMLElement.prototype, "requestFullscreen"],
    [HTMLElement.prototype, "webkitRequestFullscreen"],
    [document, "webkitFullscreenElement"],
  ] as const) {
    delete (target as unknown as Record<string, unknown>)[key]
  }
})

const panel = () => document.body.appendChild(document.createElement("div"))

describe("isTouchDevice", () => {
  it("is true only when the primary pointer is a finger", () => {
    stubMatchMedia(true)
    expect(isTouchDevice()).toBe(true)
    stubMatchMedia(false)
    expect(isTouchDevice()).toBe(false)
  })
})

describe("enterFullscreenPlayback", () => {
  it("asks for fullscreen on the given element, synchronously (before any await) so it is still inside the user's tap", () => {
    const element = panel()

    void enterFullscreenPlayback(element)

    expect(element.requestFullscreen).toHaveBeenCalledTimes(1)
  })

  it("locks to landscape only AFTER fullscreen has been granted", async () => {
    let grant!: () => void
    ;(HTMLElement.prototype.requestFullscreen as unknown) = vi.fn(function (this: HTMLElement) {
      fullscreenElement = this
      return new Promise<void>((resolve) => (grant = resolve))
    })
    const pending = enterFullscreenPlayback(panel())
    await Promise.resolve()

    expect(lock).not.toHaveBeenCalled()
    grant()
    const outcome = await pending

    expect(lock).toHaveBeenCalledExactlyOnceWith("landscape")
    expect(outcome).toEqual({ fullscreen: true, orientationLocked: true })
  })

  it("fullscreen refused: no lock is attempted and the outcome says so (never throws)", async () => {
    ;(HTMLElement.prototype.requestFullscreen as unknown) = vi.fn(() => Promise.reject(new TypeError("Permissions check failed")))

    await expect(enterFullscreenPlayback(panel())).resolves.toEqual({ fullscreen: false, orientationLocked: false })
    expect(lock).not.toHaveBeenCalled()
  })

  it("fullscreen refused synchronously (it throws instead of rejecting) is the same outcome", async () => {
    ;(HTMLElement.prototype.requestFullscreen as unknown) = vi.fn(() => {
      throw new Error("not allowed")
    })

    await expect(enterFullscreenPlayback(panel())).resolves.toEqual({ fullscreen: false, orientationLocked: false })
  })

  it("no fullscreen API at all (an iPhone's Safari, an old browser): no lock, no error", async () => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen

    await expect(enterFullscreenPlayback(panel())).resolves.toEqual({ fullscreen: false, orientationLocked: false })
    expect(lock).not.toHaveBeenCalled()
  })

  it("falls back to the WebKit-prefixed request", async () => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen
    const prefixed = vi.fn(function (this: HTMLElement) {
      fullscreenElement = this
      return Promise.resolve()
    })
    defineOnce(HTMLElement.prototype, "webkitRequestFullscreen", prefixed)

    await expect(enterFullscreenPlayback(panel())).resolves.toEqual({ fullscreen: true, orientationLocked: true })
    expect(prefixed).toHaveBeenCalledTimes(1)
  })

  it("fullscreen granted but the orientation lock is unsupported: still fullscreen, not locked", async () => {
    defineOnce(screen, "orientation", {})

    await expect(enterFullscreenPlayback(panel())).resolves.toEqual({ fullscreen: true, orientationLocked: false })
  })

  it("no screen.orientation object at all: still fullscreen, not locked", async () => {
    defineOnce(screen, "orientation", undefined)

    await expect(enterFullscreenPlayback(panel())).resolves.toEqual({ fullscreen: true, orientationLocked: false })
  })

  it("the OS or browser refusing the lock (rotation lock on, not allowed) leaves fullscreen standing and reports not locked", async () => {
    lock.mockRejectedValue(new DOMException("blocked", "NotAllowedError"))

    await expect(enterFullscreenPlayback(panel())).resolves.toEqual({ fullscreen: true, orientationLocked: false })
  })

  it("never asks for any orientation but landscape, and never rotates anything itself", async () => {
    await enterFullscreenPlayback(panel())

    expect(lock.mock.calls).toEqual([["landscape"]])
  })
})

describe("leaveFullscreenPlayback / unlockOrientation", () => {
  it("unlocks the orientation and exits fullscreen when the element is the fullscreen element", () => {
    const element = panel()
    fullscreenElement = element

    leaveFullscreenPlayback(element)

    expect(unlock).toHaveBeenCalledTimes(1)
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1)
  })

  it("also exits when a descendant (the player's own iframe) holds fullscreen", () => {
    const element = panel()
    const child = element.appendChild(document.createElement("iframe"))
    fullscreenElement = child

    leaveFullscreenPlayback(element)

    expect(document.exitFullscreen).toHaveBeenCalledTimes(1)
  })

  it("leaves a fullscreen that something else owns alone (but still releases its own orientation lock)", () => {
    fullscreenElement = panel()

    leaveFullscreenPlayback(panel())

    expect(document.exitFullscreen).not.toHaveBeenCalled()
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it("nothing fullscreen: only the unlock", () => {
    leaveFullscreenPlayback(panel())

    expect(document.exitFullscreen).not.toHaveBeenCalled()
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it("an exit that throws or rejects, or an unlock that throws, never escapes", async () => {
    const element = panel()
    fullscreenElement = element
    defineOnce(document, "exitFullscreen", vi.fn(() => Promise.reject(new Error("not in fullscreen"))))
    unlock.mockImplementation(() => {
      throw new Error("no lock held")
    })

    expect(() => leaveFullscreenPlayback(element)).not.toThrow()
    expect(() => unlockOrientation()).not.toThrow()
    await Promise.resolve()
  })

  it("currentFullscreenElement reads the standard property and the WebKit one", () => {
    expect(currentFullscreenElement()).toBeNull()
    fullscreenElement = panel()
    expect(currentFullscreenElement()).toBe(fullscreenElement)
    fullscreenElement = null
    const prefixed = panel()
    defineOnce(document, "webkitFullscreenElement", prefixed)
    expect(currentFullscreenElement()).toBe(prefixed)
  })
})
