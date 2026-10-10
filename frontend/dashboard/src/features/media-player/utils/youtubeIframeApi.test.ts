import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadYouTubeIframeApi, resetYouTubeIframeApiForTests } from "./youtubeIframeApi"

interface YouTubeWindow {
  YT?: unknown
  onYouTubeIframeAPIReady?: () => void
}
const youtubeWindow = window as unknown as YouTubeWindow
const apiScripts = () => Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]'))

beforeEach(() => {
  resetYouTubeIframeApiForTests()
})

afterEach(() => {
  apiScripts().forEach((script) => script.remove())
  delete youtubeWindow.YT
  delete youtubeWindow.onYouTubeIframeAPIReady
})

describe("loadYouTubeIframeApi", () => {
  it("injects the official script once and resolves with window.YT when the API reports ready", async () => {
    const first = loadYouTubeIframeApi()
    const second = loadYouTubeIframeApi()

    expect(apiScripts()).toHaveLength(1)
    const api = { Player: class {}, PlayerState: { PLAYING: 1 } }
    youtubeWindow.YT = api
    youtubeWindow.onYouTubeIframeAPIReady?.()

    await expect(first).resolves.toBe(api)
    await expect(second).resolves.toBe(api)
  })

  it("keeps an already-registered ready callback working", async () => {
    let previousCalled = false
    youtubeWindow.onYouTubeIframeAPIReady = () => {
      previousCalled = true
    }
    const pending = loadYouTubeIframeApi()

    youtubeWindow.YT = { Player: class {}, PlayerState: { PLAYING: 1 } }
    youtubeWindow.onYouTubeIframeAPIReady?.()
    await pending

    expect(previousCalled).toBe(true)
  })

  it("reuses an API that is already on the page without injecting a script", async () => {
    const api = { Player: class {}, PlayerState: { PLAYING: 1 } }
    youtubeWindow.YT = api

    await expect(loadYouTubeIframeApi()).resolves.toBe(api)
    expect(apiScripts()).toHaveLength(0)
  })

  it("rejects when the script fails to load, and a later call can retry", async () => {
    const failed = loadYouTubeIframeApi()
    apiScripts()[0].onerror?.(new Event("error"))
    await expect(failed).rejects.toThrow(/failed to load/)

    apiScripts().forEach((script) => script.remove())
    const retry = loadYouTubeIframeApi()
    expect(apiScripts()).toHaveLength(1)
    youtubeWindow.YT = { Player: class {}, PlayerState: { PLAYING: 1 } }
    youtubeWindow.onYouTubeIframeAPIReady?.()
    await expect(retry).resolves.toBeDefined()
  })
})
