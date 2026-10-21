import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VideoAvailability } from "./videoAvailability"
import { useVideoDeepLink } from "./useVideoDeepLink"
import { selectHomeVideo, resetHomeSelectedVideoForTests, useHomeSelectedVideo } from "../home-room/hooks/useHomeSelectedVideo"
import { markContentSeen, resetNewContentTracking } from "../../shared/newContent/newContentTracking"

const EMA = "ch_aizawa_ema"
const NOA = "ch_kurumi_noa"
const VIDEO = "dQw4w9WgXcQ"
const OTHER = "abcdefghijk"
const DEFAULT_OSHI_KEY = "yobi.defaultOshiCreatorId"
const SEEN_KEY = "yobi.newContent.seenVideoIds"

const open = (url: string) => window.history.replaceState({}, "", url)
const where = () => window.location.pathname + window.location.search

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem(DEFAULT_OSHI_KEY, NOA)
  resetHomeSelectedVideoForTests()
  resetNewContentTracking()
  open("/")
})
afterEach(() => vi.restoreAllMocks())

interface Setup {
  result: VideoAvailability | (() => Promise<VideoAvailability>)
  creator?: string
}

function mount({ result, creator = EMA }: Setup) {
  const check = vi.fn(async (_id: string) => (typeof result === "function" ? result() : result))
  const openVideo = vi.fn()
  const hook = renderHook(({ currentCreatorId }) => useVideoDeepLink({ currentCreatorId, openVideo, check }), { initialProps: { currentCreatorId: creator } })
  return { ...hook, check, openVideo }
}

const available = (title: string | null = "Exact title"): VideoAvailability => ({ status: "available", title })

describe("available videos open exactly the notified video", () => {
  it("public video (cold start on /creator/<slug>?video=<id>): checks that id, opens it with its own title, and keeps the parameter so a reload selects it again", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { check, openVideo, result } = mount({ result: available() })

    await waitFor(() => expect(openVideo).toHaveBeenCalledTimes(1))
    expect(check).toHaveBeenCalledWith(VIDEO)
    expect(openVideo).toHaveBeenCalledWith({ videoId: VIDEO, title: "Exact title" })
    expect(where()).toBe(`/creator/aizawa-ema?video=${VIDEO}`)
    expect(result.current.dialog).toBeNull()
  })

  it("a video that is not in Recent Videos still opens: resolution is by exact id and never consults any list", async () => {
    open(`/creator/aizawa-ema?video=${OTHER}`)
    const { check, openVideo } = mount({ result: available(null) })

    await waitFor(() => expect(openVideo).toHaveBeenCalledTimes(1))
    expect(check).toHaveBeenCalledTimes(1)
    expect(openVideo).toHaveBeenCalledWith({ videoId: OTHER, title: "YouTube video" })
  })

  it("an ongoing livestream, an upcoming livestream, a completed archive and an unlisted video are all just 'available' and open the same way", async () => {
    for (const title of ["Live now", "Upcoming", "Archive", "Unlisted"]) {
      open(`/creator/aizawa-ema?video=${VIDEO}`)
      const { openVideo, unmount } = mount({ result: available(title) })
      await waitFor(() => expect(openVideo).toHaveBeenCalledWith({ videoId: VIDEO, title }))
      unmount()
    }
  })

  it("opens through the real shared selection: only that video becomes the Home player's pick and only that video is marked seen", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    markContentSeen(OTHER) // an unrelated video the viewer had already opened
    const check = vi.fn(async () => available("Picked"))
    const view = renderHook(() => {
      useVideoDeepLink({ currentCreatorId: EMA, openVideo: (video) => selectHomeVideo(video, EMA), check })
      return useHomeSelectedVideo(EMA)
    })

    await waitFor(() => expect(view.result.current).toEqual({ videoId: VIDEO, title: "Picked" }))
    expect(JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]")).toEqual([OTHER, VIDEO]) // the existing NEW rule for an explicit open; nothing else touched
  })

  it("never changes the configured default Oshi", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { openVideo } = mount({ result: available() })
    await waitFor(() => expect(openVideo).toHaveBeenCalled())
    expect(window.localStorage.getItem(DEFAULT_OSHI_KEY)).toBe(NOA)

    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const failing = mount({ result: { status: "unavailable", reason: "private_or_deleted" } })
    await waitFor(() => expect(failing.result.current.dialog).toBe("private_or_deleted"))
    expect(window.localStorage.getItem(DEFAULT_OSHI_KEY)).toBe(NOA)
  })
})

describe("videos that cannot be shown leave the creator Home in place and explain why", () => {
  it.each([
    ["private or deleted", { status: "unavailable", reason: "private_or_deleted" }, "private_or_deleted"],
    ["members-only (when a source can confirm it)", { status: "unavailable", reason: "members_only" }, "members_only"],
    ["unavailable with no stated reason", { status: "unavailable", reason: "unavailable" }, "unavailable"],
    ["a failed status check (timeout / network / rate limit / 5xx)", { status: "unknown" }, "unknown"],
  ] satisfies [string, VideoAvailability, string][])("%s -> dialog '%s', nothing is opened, the URL stays on the creator", async (_name, result, kind) => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { openVideo, result: view } = mount({ result })

    await waitFor(() => expect(view.current.dialog).toBe(kind))
    expect(openVideo).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe("/creator/aizawa-ema")
  })

  it("dismissal closes the dialog, releases the parameter, and it does not come back on unrelated navigation or a re-render", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { result, rerender, check } = mount({ result: { status: "unavailable", reason: "private_or_deleted" } })
    await waitFor(() => expect(result.current.dialog).toBe("private_or_deleted"))
    expect(where()).toBe(`/creator/aizawa-ema?video=${VIDEO}`) // still there while the explanation is open: a refresh explains again

    act(() => result.current.dismiss())
    expect(result.current.dialog).toBeNull()
    expect(where()).toBe("/creator/aizawa-ema")

    open("/schedule")
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))
    rerender({ currentCreatorId: EMA })
    open("/creator/aizawa-ema")
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current.dialog).toBeNull()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("a temporary failure offers Retry: a retry that succeeds closes the dialog and opens the exact video", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const answers: VideoAvailability[] = [{ status: "unknown" }, available("Back online")]
    const { result, openVideo, check } = mount({ result: async () => answers.shift() ?? { status: "unknown" } })
    await waitFor(() => expect(result.current.dialog).toBe("unknown"))
    expect(openVideo).not.toHaveBeenCalled()

    act(() => result.current.retry())

    await waitFor(() => expect(openVideo).toHaveBeenCalledWith({ videoId: VIDEO, title: "Back online" }))
    expect(result.current.dialog).toBeNull()
    expect(check).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenLastCalledWith(VIDEO)
  })

  it("a retry that fails again keeps a temporary-failure dialog (never turns into 'private')", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { result } = mount({ result: { status: "unknown" } })
    await waitFor(() => expect(result.current.dialog).toBe("unknown"))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.dialog).toBe("unknown"))
  })

  it("closing the dialog while a retry is still checking does not reopen it afterwards", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    let release: (value: VideoAvailability) => void = () => undefined
    const answers: Array<() => Promise<VideoAvailability>> = [async () => ({ status: "unknown" }), () => new Promise((resolve) => (release = resolve))]
    const { result } = mount({ result: () => (answers.shift() ?? (async () => ({ status: "unknown" as const })))() })
    await waitFor(() => expect(result.current.dialog).toBe("unknown"))

    act(() => result.current.retry())
    act(() => result.current.dismiss())
    release({ status: "unknown" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current.dialog).toBeNull()
  })
})

describe("what is ignored", () => {
  it.each([["a too-short id", "short"], ["a URL", "https%3A%2F%2Fevil.test"], ["an id with a path", "abc/defghij"], ["an empty value", ""]])("invalid video id (%s): no check, no dialog, parameter removed, creator Home untouched", async (_name, raw) => {
    open(`/creator/aizawa-ema?video=${raw}`)
    const { check, openVideo, result } = mount({ result: available() })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(check).not.toHaveBeenCalled()
    expect(openVideo).not.toHaveBeenCalled()
    expect(result.current.dialog).toBeNull()
    expect(where()).toBe("/creator/aizawa-ema")
  })

  it("an invalid creator slug (the router has already fallen back to /): the id is not applied to anyone and the parameter is removed", async () => {
    open(`/?video=${VIDEO}`)
    const { check, openVideo } = mount({ result: available() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(check).not.toHaveBeenCalled()
    expect(openVideo).not.toHaveBeenCalled()
    expect(where()).toBe("/")

    open(`/creator/not-a-creator?video=${VIDEO}`)
    mount({ result: available() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(check).not.toHaveBeenCalled()
  })

  it("a creator-only notification (no video parameter) does nothing at all", async () => {
    open("/creator/aizawa-ema")
    const { check, openVideo, result } = mount({ result: available() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(check).not.toHaveBeenCalled()
    expect(openVideo).not.toHaveBeenCalled()
    expect(result.current.dialog).toBeNull()
    expect(where()).toBe("/creator/aizawa-ema")
  })

  it("the viewer changed creator while the check was running: nothing is opened for the wrong creator", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    let release: (value: VideoAvailability) => void = () => undefined
    const { rerender, openVideo } = mount({ result: () => new Promise((resolve) => (release = resolve)) })
    rerender({ currentCreatorId: NOA })
    release(available())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openVideo).not.toHaveBeenCalled()
  })
})

describe("refresh, Back/Forward and repeated clicks", () => {
  it("refreshing the deep-link URL selects the same exact video again (the target survives a reload)", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const first = mount({ result: available() })
    await waitFor(() => expect(first.openVideo).toHaveBeenCalledTimes(1))
    first.unmount()

    const reloaded = mount({ result: available("After reload") }) // F5: the address bar still carries the parameter
    await waitFor(() => expect(reloaded.openVideo).toHaveBeenCalledWith({ videoId: VIDEO, title: "After reload" }))
    expect(reloaded.check).toHaveBeenCalledWith(VIDEO)
  })

  it("the parameter stays while the check is still running, so an interrupted load still reloads onto the same video", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    mount({ result: () => new Promise(() => undefined) })
    expect(where()).toBe(`/creator/aizawa-ema?video=${VIDEO}`)
  })

  it("a video that is slow to check opens when the answer arrives (asynchronous loading after navigation)", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    let release: (value: VideoAvailability) => void = () => undefined
    const { openVideo } = mount({ result: () => new Promise((resolve) => (release = resolve)) })
    expect(openVideo).not.toHaveBeenCalled()
    release(available("Late"))
    await waitFor(() => expect(openVideo).toHaveBeenCalledWith({ videoId: VIDEO, title: "Late" }))
  })

  it("selecting a DIFFERENT video releases the parameter; selecting the linked video, or a first render, does not", () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const check = vi.fn(async () => available())
    const { rerender } = renderHook(({ selected }) => useVideoDeepLink({ currentCreatorId: EMA, openVideo: vi.fn(), selectedVideoId: selected, check }), {
      initialProps: { selected: OTHER as string | null }, // a pick that predates the link (e.g. Back onto a link entry) must not release it
    })
    expect(where()).toBe(`/creator/aizawa-ema?video=${VIDEO}`)

    rerender({ selected: VIDEO }) // the link's own video becomes the pick
    expect(where()).toBe(`/creator/aizawa-ema?video=${VIDEO}`)

    rerender({ selected: OTHER }) // the viewer chose something else
    expect(where()).toBe("/creator/aizawa-ema")
  })

  it("Back/Forward over history entries carrying no parameter never re-runs a deep link", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { openVideo, check } = mount({ result: available() })
    await waitFor(() => expect(openVideo).toHaveBeenCalledTimes(1))

    window.history.pushState({}, "", "/schedule")
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))
    window.history.pushState({}, "", "/creator/aizawa-ema")
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(check).toHaveBeenCalledTimes(1)
    expect(openVideo).toHaveBeenCalledTimes(1)
  })

  it("Back/Forward onto an entry that does carry a deep link applies it (once)", async () => {
    open("/creator/aizawa-ema")
    const { openVideo, check } = mount({ result: available() })
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))

    await waitFor(() => expect(openVideo).toHaveBeenCalledTimes(1))
    expect(check).toHaveBeenCalledTimes(1)
    expect(where()).toBe(`/creator/aizawa-ema?video=${VIDEO}`)
  })

  it("a second notification click for the same video in the same page replaces the first: one open, one dialog at most", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { openVideo, check } = mount({ result: available() })
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openVideo).toHaveBeenCalledTimes(1) // the first answer was superseded; only the latest click applies
  })

  it("two clicks that both fail show exactly one dialog", async () => {
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    const { result } = mount({ result: { status: "unavailable", reason: "private_or_deleted" } })
    open(`/creator/aizawa-ema?video=${VIDEO}`)
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))
    await waitFor(() => expect(result.current.dialog).toBe("private_or_deleted"))
    act(() => result.current.dismiss())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current.dialog).toBeNull()
  })
})
