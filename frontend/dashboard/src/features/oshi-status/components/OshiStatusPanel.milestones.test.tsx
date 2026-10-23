import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OshiStatusPanel } from "./OshiStatusPanel"
import * as useLastVisit from "../hooks/useLastVisit"
import { fetchOshiStatus } from "../data/oshiStatus"
import { loadCreatorMilestones, type CreatorMilestonesResult } from "../data/creatorMilestones"
import { getCachedAllCreatorMilestones, loadAllCreatorMilestones, type AllCreatorMilestones } from "../data/allCreatorMilestones"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import type { CreatorStatus } from "../../live-status/model/creatorStatus"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../hooks/useLastVisit", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useLastVisit")>("../hooks/useLastVisit")
  return { ...actual, usePreviousVisit: vi.fn() }
})
vi.mock("../data/oshiStatus", () => ({ fetchOshiStatus: vi.fn() }))
vi.mock("../data/creatorMilestones", () => ({ loadCreatorMilestones: vi.fn(), getCachedCreatorMilestones: vi.fn(() => undefined) }))
// The calendar icon is decided by the shared bulk read (every creator it lists with at least one usable date); the real predicate is kept.
vi.mock("../data/allCreatorMilestones", async () => {
  const actual = await vi.importActual<typeof import("../data/allCreatorMilestones")>("../data/allCreatorMilestones")
  return { ...actual, getCachedAllCreatorMilestones: vi.fn(), loadAllCreatorMilestones: vi.fn() }
})

const statusMock = vi.mocked(fetchOshiStatus)
const loadMock = vi.mocked(loadCreatorMilestones)
const bulkCachedMock = vi.mocked(getCachedAllCreatorMilestones)
const bulkLoadMock = vi.mocked(loadAllCreatorMilestones)

/** The shared bulk read as the panel sees it: what is already held AND what a (re)load answers. */
function setBulk(bulk: AllCreatorMilestones) {
  bulkCachedMock.mockReturnValue(bulk)
  bulkLoadMock.mockResolvedValue(bulk)
}

/** A bulk read in which EVERY creator has both dates (the default of these tests); a test replaces it to model creators without dates. */
const everyCreatorHasDates = new Proxy({} as AllCreatorMilestones, { get: () => ({ birthday: "01-31", debutDate: "2021-09-18" }) })

/** An absolute instant from JST wall-clock fields. */
const jst = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3600 * 1000
const NOW_MS = jst(2026, 10, 18, 12, 0, 0)

const EMA = { creatorId: "aizawa_ema", birthday: "01-31", debutDate: "2021-09-18" }
const found = (milestones: typeof EMA): CreatorMilestonesResult => ({ kind: "found", milestones })

const emptyFeed = (): HomeAllFeed => {
  const page = {
    videos: [],
    loading: false,
    error: null,
    loadMore: vi.fn(),
    hasMore: false,
    newContent: { videoIds: [], livestreamIds: [], unclassifiedIds: [] },
  }
  return { ...page, page }
}

const LIVE: CreatorStatus = { kind: "live", videoId: "live_1", title: "Live now" }
const UPCOMING: CreatorStatus = { kind: "upcoming", videoId: "up_1", title: "Soon", scheduledStart: "2026-10-18T13:00:00+09:00" }
const OFFLINE: CreatorStatus = { kind: "offline" }

/** The dialog overlays the Now Playing section when a video is loaded, so by default one is (pass null for an OFFLINE creator with nothing loaded). */
function renderPanel(creatorId = "ch_aizawa_ema", nowPlayingTitle: string | null = "A video", status: CreatorStatus = OFFLINE) {
  const feed = emptyFeed()
  let currentId = creatorId
  const ui = (id: string, title: string | null, current: CreatorStatus) => (
    <OshiStatusPanel creatorId={id} status={current} feed={feed} now={new Date(NOW_MS)} onSelectVideo={vi.fn()} nowPlayingTitle={title} />
  )
  const view = render(ui(creatorId, nowPlayingTitle, status))
  return {
    unmount: view.unmount,
    switchCreator: (id: string) => {
      currentId = id
      view.rerender(ui(id, nowPlayingTitle, status))
    },
    /** The same creator, now LIVE / OFFLINE / ...: a different status and Now Playing title while the dialog may be open. */
    update: (title: string | null, next: CreatorStatus) => view.rerender(ui(currentId, title, next)),
  }
}
const trigger = () => screen.getByRole("button", { name: /birthday and debut anniversary|誕生日とデビュー記念日|生日與出道紀念日/i })
const dialog = () => screen.queryByRole("dialog")

/** Label / date / countdown of each row of the open dialog. */
function rows(): string[][] {
  return Array.from(document.querySelectorAll(".oshi-status__milestone-row")).map((row) => Array.from(row.children).map((cell) => cell.textContent ?? ""))
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width })
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width })
}

beforeEach(() => {
  statusMock.mockReset()
  statusMock.mockResolvedValue({
    subscriberCount: 123_456,
    latestVideo: null,
    thisWeek: { newUploads: 0, newStreams: 0 },
    growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
    sinceLastVisit: null,
  })
  vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
  loadMock.mockReset()
  loadMock.mockResolvedValue(found(EMA))
  bulkCachedMock.mockReset()
  bulkCachedMock.mockReturnValue(everyCreatorHasDates)
  bulkLoadMock.mockReset()
  bulkLoadMock.mockResolvedValue(everyCreatorHasDates)
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  setViewport(1280)
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW_MS)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("calendar icon", () => {
  it("sits immediately after the subscriber count and opens nothing by itself", async () => {
    renderPanel()
    const count = await screen.findByText(/123\.5K/)
    const button = trigger()
    expect(count.nextElementSibling).toBe(button)
    expect(count.parentElement).toBe(button.parentElement)
    expect(button).toHaveAttribute("aria-expanded", "false")
    expect(button.querySelector("svg")).not.toBeNull()
    expect(dialog()).toBeNull()
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("is shown for a creator with a birthday and a debut date, and for one with only a single date", async () => {
    for (const dates of [{ birthday: "01-31", debutDate: "2021-09-18" }, { birthday: "01-31" }, { debutDate: "2021-09-18" }]) {
      setBulk({ aizawa_ema: dates })
      const view = renderPanel()
      await screen.findByText(/123\.5K/)
      expect(trigger()).toBeInTheDocument()
      view.unmount()
    }
  })

  it("is hidden for an entry with neither date -- a staff, official or organization channel is decided by its missing data, never by its name", async () => {
    // The roster lists only a creator that HAS dates; the entry shown (any id, whatever its name or type) is absent from it, or listed without a usable date.
    for (const bulk of [{ some_other_creator: { birthday: "01-31", debutDate: "2021-09-18" } }, { aizawa_ema: {} }] as AllCreatorMilestones[]) {
      setBulk(bulk)
      const view = renderPanel()
      await screen.findByText(/123\.5K/)
      expect(screen.queryByRole("button", { name: /birthday and debut anniversary/i })).toBeNull()
      expect(document.querySelector(".oshi-status__milestone-trigger")).toBeNull()
      view.unmount()
    }
  })

  it("hiding it leaves the subscriber line, its height rule and the name exactly where they were", async () => {
    setBulk({})
    renderPanel()
    const count = await screen.findByText(/123\.5K/)
    const row = count.parentElement as HTMLElement
    expect(row).toHaveClass("oshi-status__subscriber-row") // the row (fixed 13px high in home.css) still exists, so nothing moves
    // The row holds the registry caption and the count -- and, with the milestone hidden, nothing else (no calendar button).
    expect([...row.children].map((child) => child.className)).toEqual(["oshi-status__creator-meta", "oshi-status__subscriber-count"])
    expect(row.previousElementSibling).toHaveClass("oshi-status__creator-name")
    expect(row.parentElement).toHaveClass("oshi-status__creator-text")
  })

  it("hiding it does not hide any other control of the panel", async () => {
    setBulk({})
    renderPanel()
    await screen.findByText(/123\.5K/)
    expect(screen.getByRole("button", { name: "Mark all watched" })).toBeInTheDocument()
    expect(screen.getByText("Recent")).toBeInTheDocument()
  })

  it("waits for the bulk read when nothing is held yet, then appears; an unreadable read keeps it hidden", async () => {
    bulkCachedMock.mockReturnValue(null)
    let resolveRead: (value: AllCreatorMilestones) => void = () => undefined
    bulkLoadMock.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)))
    renderPanel()
    await screen.findByText(/123\.5K/)
    expect(document.querySelector(".oshi-status__milestone-trigger")).toBeNull()
    await act(async () => resolveRead({ aizawa_ema: { birthday: "01-31" } }))
    expect(trigger()).toBeInTheDocument()

    bulkCachedMock.mockReturnValue(null)
    bulkLoadMock.mockRejectedValue(new Error("offline"))
    renderPanel()
    await waitFor(() => expect(bulkLoadMock).toHaveBeenCalledTimes(2))
    expect(screen.getAllByRole("button", { name: /birthday and debut anniversary/i })).toHaveLength(1) // only the first panel's
  })

  it("asks for no milestone request of its own: the icon uses the one shared bulk read", async () => {
    renderPanel()
    await screen.findByText(/123\.5K/)
    expect(bulkLoadMock).toHaveBeenCalledTimes(1)
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("is still there when the subscriber count is unavailable", async () => {
    statusMock.mockResolvedValue({ subscriberCount: null, latestVideo: null, thisWeek: { newUploads: 0, newStreams: 0 }, growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } }, sinceLastVisit: null })
    renderPanel()
    expect(trigger()).toBeInTheDocument()
  })
})

describe("dialog content", () => {
  it("shows exactly two rows and no heading", async () => {
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(rows()).toHaveLength(2)
    expect(within(screen.getByRole("dialog")).queryByRole("heading")).toBeNull()
    // Two event rows, then the timezone caption (not a row, not a heading).
    expect(screen.getByRole("dialog").children).toHaveLength(3)
    expect(screen.getByRole("dialog").lastElementChild).toHaveClass("oshi-status__milestone-caption")
  })

  it.each([
    ["en", [["Birthday", "Jan 31", "3mo 12d 12h 0m 0s"], ["6th Anniversary", "Sep 18", "10mo 30d 12h 0m 0s"]]],
    ["ja", [["誕生日", "1月31日", "3ヶ月 12日 12時間 0分 0秒"], ["6周年記念日", "9月18日", "10ヶ月 30日 12時間 0分 0秒"]]],
    ["zh-TW", [["生日", "1月31日", "3個月 12天 12小時 0分 0秒"], ["6周年紀念日", "9月18日", "10個月 30天 12小時 0分 0秒"]]],
  ] as const)("%s: label, date and countdown of both rows", async (locale, expected) => {
    localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(rows()).toEqual(expected)
  })

  it("asks for the CURRENT creator canonical id, once, and renders that creator dates", async () => {
    renderPanel("ch_aizawa_ema")
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(loadMock).toHaveBeenCalledWith("aizawa_ema")
  })
})

describe("Feb 29 birthday", () => {
  it.each([
    ["en", ["Birthday", "Feb 29", "4mo 9d 12h 0m 0s"]],
    ["ja", ["誕生日", "2月29日", "4ヶ月 9日 12時間 0分 0秒"]],
    ["zh-TW", ["生日", "2月29日", "4個月 9天 12小時 0分 0秒"]],
  ] as const)("%s: shows the official Feb 29 while counting down to Feb 28 00:00 JST in a common year", async (locale, expected) => {
    loadMock.mockResolvedValue(found({ creatorId: "hakos_baelz", birthday: "02-29", debutDate: "2021-08-23" }))
    localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    renderPanel("ch_hakos_baelz")
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(rows()[0]).toEqual(expected)
  })
})
describe("timezone caption", () => {
  it.each([
    ["en", "Based on JST 00:00"],
    ["ja", "JST 00:00基準"],
    ["zh-TW", "以 JST 00:00 為準"],
  ] as const)("%s: the caption under the two rows reads %s", async (locale, expected) => {
    localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    const caption = open.querySelector(".oshi-status__milestone-caption")
    expect(caption).toHaveTextContent(expected)
    expect(rows()).toHaveLength(2)
    expect(open.lastElementChild).toBe(caption)
    // After both rows, not a heading, and not itself an event row.
    expect(caption?.tagName).toBe("DIV")
    expect(caption).not.toHaveClass("oshi-status__milestone-row")
    expect(within(open).queryByRole("heading")).toBeNull()
  })

  it("is shown while loading and when the read fails, and the dialog keeps its measured size", async () => {
    loadMock.mockReturnValue(new Promise(() => {}))
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    expect(open.querySelector(".oshi-status__milestone-caption")).toHaveTextContent("Based on JST 00:00")
    // Size and position are the measured anchor rectangle as before; the caption adds nothing to the inline geometry.
    expect(Object.keys(open.style).length).toBeGreaterThan(0)
    expect(open.style.width).not.toBe("")
    expect(open.style.height).not.toBe("")
  })
})
describe("loading and failure never fabricate values", () => {
  it("shows placeholders while loading", async () => {
    loadMock.mockReturnValue(new Promise(() => {}))
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(rows()).toEqual([["Birthday", "—", "—"], ["Anniversary", "—", "—"]])
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true")
  })

  it("shows placeholders and a hint when the read fails, and retries on the next open", async () => {
    loadMock.mockRejectedValueOnce(new Error("boom"))
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await waitFor(() => expect(rows()[0][1]).toBe("—"))
    expect(document.querySelector(".oshi-status__milestone-row")).toHaveAttribute("title", "Data is temporarily unavailable")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(dialog()).toBeNull()

    fireEvent.click(trigger(), { detail: 0 })
    await waitFor(() => expect(rows()[0][1]).toBe("Jan 31"))
    expect(loadMock).toHaveBeenCalledTimes(2)
  })

  it("shows placeholders when the creator has no record", async () => {
    loadMock.mockResolvedValue({ kind: "not_found" })
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await waitFor(() => expect(rows()).toEqual([["Birthday", "—", "—"], ["Anniversary", "—", "—"]]))
  })
})

describe("desktop hover", () => {
  it("opens on hover and closes after leaving", async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.hover(trigger())
    await screen.findByRole("dialog")
    await user.unhover(trigger())
    await waitFor(() => expect(dialog()).toBeNull(), { timeout: 1500 })
  })

  it("does not flicker when the pointer moves from the icon onto the dialog that covers it", async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.hover(trigger())
    const open = await screen.findByRole("dialog")
    await user.unhover(trigger())
    await user.hover(open)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(dialog()).toBeInTheDocument()
    await user.unhover(open)
    await waitFor(() => expect(dialog()).toBeNull(), { timeout: 1500 })
  })

  it("a mouse click on a hover-opened dialog keeps it open", async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.hover(trigger())
    await screen.findByRole("dialog")
    fireEvent.pointerDown(trigger(), { pointerType: "mouse" })
    fireEvent.click(trigger(), { detail: 1 })
    expect(dialog()).toBeInTheDocument()
  })
})

describe("mobile tap", () => {
  beforeEach(() => setViewport(390))

  it("a tap opens it, a second tap closes it, and touch hover never opens it", async () => {
    renderPanel()
    fireEvent.pointerEnter(trigger(), { pointerType: "touch" })
    expect(dialog()).toBeNull()
    fireEvent.pointerDown(trigger(), { pointerType: "touch" })
    fireEvent.click(trigger(), { detail: 1 })
    await screen.findByRole("dialog")
    fireEvent.pointerDown(trigger(), { pointerType: "touch" })
    fireEvent.click(trigger(), { detail: 1 })
    expect(dialog()).toBeNull()
  })

  it("tapping outside closes it, tapping inside does not", async () => {
    renderPanel()
    fireEvent.pointerDown(trigger(), { pointerType: "touch" })
    fireEvent.click(trigger(), { detail: 1 })
    const open = await screen.findByRole("dialog")
    fireEvent.pointerDown(open, { pointerType: "touch" })
    expect(dialog()).toBeInTheDocument()
    fireEvent.pointerDown(document.body, { pointerType: "touch" })
    expect(dialog()).toBeNull()
  })
})

describe("keyboard", () => {
  it("opens from the keyboard and Escape dismisses it", async () => {
    renderPanel()
    trigger().focus()
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(trigger()).toHaveAttribute("aria-expanded", "true")
    expect(trigger()).toHaveAttribute("aria-controls", screen.getByRole("dialog").id)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(dialog()).toBeNull()
    expect(trigger()).toHaveAttribute("aria-expanded", "false")
  })
})

describe("the cross-origin player", () => {
  it("lets pointer events through only while the dialog is open, so leaving over or tapping the player behaves like any other area", async () => {
    renderPanel()
    expect(document.documentElement).not.toHaveAttribute("data-oshi-milestone-open")
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(document.documentElement).toHaveAttribute("data-oshi-milestone-open", "true")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(document.documentElement).not.toHaveAttribute("data-oshi-milestone-open")
  })
})
describe("overlay geometry from the rendered elements", () => {
  const make = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) })
  function stubRects(panelWidth = 300, nowPlayingHeight = 160) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("oshi-status")) return make(16, 100, panelWidth, 600)
      if (this.classList.contains("oshi-status__header-top")) return make(28, 108, panelWidth - 24, 44)
      if (this.classList.contains("oshi-status__now-playing")) return make(28, 160, panelWidth - 24, nowPlayingHeight)
      return make(0, 0, 0, 0)
    })
  }

  it("desktop: the panel width, exactly the Now Playing section, and below the creator header", async () => {
    stubRects()
    renderPanel("ch_aizawa_ema", "A video")
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    expect(open.style.width).toBe("300px")
    expect(open.style.height).toBe("160px")
    // Panel top is 100 and the Now Playing top is 160, so the overlay starts 60px below the panel top, under the 44px creator row that ends at 152.
    expect(open.style.top).toBe("60px")
    expect(open.style.left).toMatch(/^(-0|0)px$/)
  })

  it("never covers the creator header: the overlay top is the Now Playing top, below the creator row bottom", async () => {
    stubRects()
    renderPanel("ch_aizawa_ema", "A video")
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    const creatorRowBottom = 108 + 44
    const overlayTopInViewport = 100 + parseFloat(open.style.top)
    expect(overlayTopInViewport).toBe(160)
    expect(overlayTopInViewport).toBeGreaterThanOrEqual(creatorRowBottom)
    expect(overlayTopInViewport + parseFloat(open.style.height)).toBe(320)
    // The icon stays reachable: it is not inside the dialog, which is a sibling of the header in the panel.
    expect(open).not.toContainElement(trigger())
  })

  it("mobile: the panel's own left and right edges (its side margins, not the viewport edges), only the Now Playing span", async () => {
    setViewport(390)
    // The panel is stubbed at left 16 with a width narrower than the 390px viewport, as on the stacked mobile layout.
    stubRects(358)
    renderPanel("ch_aizawa_ema", "A video")
    fireEvent.pointerDown(trigger(), { pointerType: "touch" })
    fireEvent.click(trigger(), { detail: 1 })
    const open = await screen.findByRole("dialog")
    expect(open.style.width).toBe("358px")
    // The dialog is positioned inside the panel (the containing block), so no offset from the panel's own left edge.
    expect(open.style.left).toMatch(/^(-0|0)px$/)
    expect(open.style.top).toBe("60px")
    expect(open.style.height).toBe("160px")
  })

  it("re-measures when the window is resized", async () => {
    stubRects()
    renderPanel("ch_aizawa_ema", "A video")
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    expect(open.style.width).toBe("300px")
    stubRects(340, 180)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(screen.getByRole("dialog").style.width).toBe("340px")
    expect(screen.getByRole("dialog").style.height).toBe("180px")
  })

  it("never changes the layout underneath: the dialog is a positioned overlay child of the panel", async () => {
    renderPanel("ch_aizawa_ema", "A video")
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    expect(open.parentElement).toHaveClass("oshi-status")
    expect(open).toHaveClass("oshi-status__milestone-dialog")
  })
})
describe("one standard Now Playing region: the dialog geometry never depends on livestream or network state", () => {
  const make = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) })
  /** The Now Playing region is a fixed-footprint element whatever it contains, so its rect is the same in every state (that is what the markup guarantees). */
  function stubRects(panelWidth = 300, nowPlayingHeight = 200) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("oshi-status")) return make(16, 100, panelWidth, 600)
      if (this.classList.contains("oshi-status__header-top")) return make(28, 108, panelWidth - 24, 44)
      if (this.classList.contains("oshi-status__now-playing")) return make(28, 160, panelWidth - 24, nowPlayingHeight)
      return make(0, 0, 0, 0)
    })
  }
  const geometryOf = (open: HTMLElement) => ({ top: open.style.top, left: open.style.left, width: open.style.width, height: open.style.height })

  const STATES = [
    ["LIVE with a video", LIVE, "A live video", { kind: "found" }],
    ["UPCOMING", UPCOMING, "A video", { kind: "found" }],
    ["OFFLINE with a video loaded", OFFLINE, "A video", { kind: "found" }],
    ["OFFLINE with no video available", OFFLINE, null, { kind: "found" }],
    ["no video and milestones 404", OFFLINE, null, { kind: "404" }],
    ["no video and milestones 503", OFFLINE, null, { kind: "503" }],
    ["no video and a network failure", OFFLINE, null, { kind: "network" }],
    ["no video and milestones still loading", OFFLINE, null, { kind: "loading" }],
  ] as const

  function arrange(milestones: { kind: string }) {
    if (milestones.kind === "404") loadMock.mockResolvedValue({ kind: "not_found" })
    else if (milestones.kind === "503") loadMock.mockRejectedValue(new Error("503 MILESTONES_UNAVAILABLE"))
    else if (milestones.kind === "network") loadMock.mockRejectedValue(new TypeError("Failed to fetch"))
    else if (milestones.kind === "loading") loadMock.mockReturnValue(new Promise(() => {}))
    else loadMock.mockResolvedValue(found({ creatorId: "kaga_nazuna", birthday: "04-02", debutDate: "2018-10-20" }))
  }

  it("the Now Playing region exists with the same parts in every state", () => {
    for (const [label, status, title] of STATES) {
      const view = render(<OshiStatusPanel creatorId="ch_kaga_nazuna" status={status} feed={emptyFeed()} now={new Date(NOW_MS)} onSelectVideo={vi.fn()} nowPlayingTitle={title} />)
      const region = view.container.querySelector(".oshi-status__now-playing")
      expect(region, label).not.toBeNull()
      expect(region?.children.length, label).toBe(3)
      expect(region?.querySelector(".oshi-status__now-playing-label"), label).not.toBeNull()
      expect(region?.querySelector(".oshi-status__now-playing-title"), label).not.toBeNull()
      expect(region?.querySelector(".oshi-status__now-playing-thumb"), label).not.toBeNull()
      view.unmount()
    }
  })

  it("the dialog geometry is identical in every state, and the creator header is never covered", async () => {
    stubRects()
    const seen: Record<string, string> = {}
    for (const [label, status, title, milestones] of STATES) {
      loadMock.mockReset()
      arrange(milestones)
      const view = render(<OshiStatusPanel creatorId="ch_kaga_nazuna" status={status} feed={emptyFeed()} now={new Date(NOW_MS)} onSelectVideo={vi.fn()} nowPlayingTitle={title} />)
      fireEvent.click(trigger(), { detail: 0 })
      const open = await screen.findByRole("dialog")
      await act(async () => {
        await Promise.resolve()
      })
      seen[label] = JSON.stringify(geometryOf(screen.getByRole("dialog")))
      // Panel top 100 + offset = the Now Playing top (160), below the 44px creator row that ends at 152; the height is the region height.
      expect(100 + parseFloat(open.style.top), label).toBe(160)
      expect(100 + parseFloat(open.style.top), label).toBeGreaterThanOrEqual(108 + 44)
      expect(parseFloat(open.style.height), label).toBe(200)
      expect(open.style.width, label).toBe("300px")
      view.unmount()
    }
    expect(new Set(Object.values(seen)).size).toBe(1)
  })

  it.each([
    ["404", { kind: "404" }, [["Birthday", "—", "—"], ["Anniversary", "—", "—"]]],
    ["503", { kind: "503" }, [["Birthday", "—", "—"], ["Anniversary", "—", "—"]]],
    ["a network failure", { kind: "network" }, [["Birthday", "—", "—"], ["Anniversary", "—", "—"]]],
    ["loading", { kind: "loading" }, [["Birthday", "—", "—"], ["Anniversary", "—", "—"]]],
  ] as const)("milestones %s: placeholders only (no fabricated dates) and the footprint is unchanged", async (_label, milestones, expectedRows) => {
    stubRects()
    arrange(milestones)
    renderPanel("ch_kaga_nazuna", null, OFFLINE)
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    await waitFor(() => expect(rows()).toEqual(expectedRows))
    expect(open.style.height).toBe("200px")
    expect(open.querySelector(".oshi-status__milestone-caption")).not.toBeNull()
  })

  it("unrelated Oshi Status requests failing do not stop an already loaded milestone dialog from opening", async () => {
    statusMock.mockReset()
    statusMock.mockRejectedValue(new Error("oshi-status 503"))
    loadMock.mockResolvedValue(found(EMA))
    renderPanel("ch_aizawa_ema", null, OFFLINE)
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    await waitFor(() => expect(rows()[0][1]).toBe("Jan 31"))
  })

  it.each([
    ["LIVE", LIVE, "A live video"],
    ["UPCOMING", UPCOMING, "A video"],
    ["OFFLINE", OFFLINE, null],
  ] as const)("%s: opens with the creator own dates", async (_label, status, title) => {
    loadMock.mockResolvedValue(found({ creatorId: "kaga_nazuna", birthday: "04-02", debutDate: "2018-10-20" }))
    renderPanel("ch_kaga_nazuna", title, status)
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    expect(loadMock).toHaveBeenCalledWith("kaga_nazuna")
    expect(rows()).toEqual([["Birthday", "Apr 2", "5mo 14d 12h 0m 0s"], ["8th Anniversary", "Oct 20", "1d 12h 0m 0s"]])
  })

  it("Kaga Nazuna, OFFLINE with nothing loaded: opens on desktop hover and mobile tap", async () => {
    loadMock.mockResolvedValue(found({ creatorId: "kaga_nazuna", birthday: "04-02", debutDate: "2018-10-20" }))
    const user = userEvent.setup()
    renderPanel("ch_kaga_nazuna", null, OFFLINE)
    await user.hover(trigger())
    await screen.findByRole("dialog")
    await user.unhover(trigger())
    await waitFor(() => expect(dialog()).toBeNull(), { timeout: 1500 })

    setViewport(390)
    fireEvent.pointerDown(trigger(), { pointerType: "touch" })
    fireEvent.click(trigger(), { detail: 1 })
    await screen.findByRole("dialog")
  })

  it("mobile: the panel's edges and the same vertical span in every state, with no horizontal overflow", async () => {
    setViewport(390)
    stubRects(358)
    for (const [label, status, title] of [["LIVE", LIVE, "A live video"], ["no video", OFFLINE, null]] as const) {
      const view = render(<OshiStatusPanel creatorId="ch_kaga_nazuna" status={status} feed={emptyFeed()} now={new Date(NOW_MS)} onSelectVideo={vi.fn()} nowPlayingTitle={title} />)
      fireEvent.pointerDown(trigger(), { pointerType: "touch" })
      fireEvent.click(trigger(), { detail: 1 })
      const open = await screen.findByRole("dialog")
      expect(open.style.width, label).toBe("358px")
      expect(open.style.left, label).toMatch(/^(-0|0)px$/)
      expect(open.style.top, label).toBe("60px")
      expect(open.style.height, label).toBe("200px")
      view.unmount()
    }
  })

  it("LIVE -> OFFLINE and OFFLINE -> LIVE while open: the dialog stays open with the same geometry", async () => {
    stubRects()
    const view = renderPanel("ch_aizawa_ema", "A live video", LIVE)
    fireEvent.click(trigger(), { detail: 0 })
    const open = await screen.findByRole("dialog")
    const before = JSON.stringify(geometryOf(open))
    view.update(null, OFFLINE)
    expect(JSON.stringify(geometryOf(screen.getByRole("dialog")))).toBe(before)
    view.update("A live video", LIVE)
    expect(JSON.stringify(geometryOf(screen.getByRole("dialog")))).toBe(before)
  })

  it("keeps counting down live for an OFFLINE creator", async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(NOW_MS)
    renderPanel("ch_aizawa_ema", null, OFFLINE)
    fireEvent.click(trigger(), { detail: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(rows()[0][2]).toBe("3mo 12d 12h 0m 0s")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2005)
    })
    expect(rows()[0][2]).toBe("3mo 12d 11h 59m 58s")
  })
})
describe("creator switching", () => {
  it("closes, then loads the NEW creator on the next open", async () => {
    loadMock.mockImplementation(async (id) => found(id === "aizawa_ema" ? EMA : { creatorId: "kaga_sumire", birthday: "04-02", debutDate: "2018-10-20" }))
    const view = renderPanel("ch_aizawa_ema")
    fireEvent.click(trigger(), { detail: 0 })
    await waitFor(() => expect(rows()[0][1]).toBe("Jan 31"))
    view.switchCreator("ch_kaga_sumire")
    expect(dialog()).toBeNull()
    fireEvent.click(trigger(), { detail: 0 })
    await waitFor(() => expect(rows()[0][1]).toBe("Apr 2"))
    expect(loadMock.mock.calls.map((call) => call[0])).toEqual(["aizawa_ema", "kaga_sumire"])
  })
})

describe("switching back to a creator", () => {
  it("does not reopen the dialog (A open -> B -> A stays closed and makes no new read)", async () => {
    loadMock.mockImplementation(async (id) => found(id === "aizawa_ema" ? EMA : { creatorId: "kaga_sumire", birthday: "04-02", debutDate: "2018-10-20" }))
    const view = renderPanel("ch_aizawa_ema")
    // Opened from the keyboard: no pointer press exists to close it on the way out.
    fireEvent.click(trigger(), { detail: 0 })
    await screen.findByRole("dialog")
    const readsBefore = loadMock.mock.calls.length

    view.switchCreator("ch_kaga_sumire")
    expect(dialog()).toBeNull()
    view.switchCreator("ch_aizawa_ema")
    expect(dialog()).toBeNull()
    expect(trigger()).toHaveAttribute("aria-expanded", "false")
    await act(async () => {
      await Promise.resolve()
    })
    expect(loadMock.mock.calls.length).toBe(readsBefore)
  })
})

describe("the one-second timer", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(NOW_MS)
  })

  it("updates once per second while open without reading the backend again, and leaves no timer behind when closed", async () => {
    renderPanel()
    const baseline = vi.getTimerCount()
    fireEvent.click(trigger(), { detail: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(rows()[0][2]).toBe("3mo 12d 12h 0m 0s")
    expect(vi.getTimerCount()).toBeGreaterThan(baseline)

    await act(async () => {
      // The first tick lands 5 ms after the next wall-clock second boundary (here exactly 1 s away), never on a drifting fixed interval.
      await vi.advanceTimersByTimeAsync(1005)
    })
    expect(rows()[0][2]).toBe("3mo 12d 11h 59m 59s")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(rows()[0][2]).toBe("3mo 12d 11h 59m 56s")
    expect(loadMock).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: "Escape" })
    expect(dialog()).toBeNull()
    expect(vi.getTimerCount()).toBe(baseline)
  })
  it("recomputes from the absolute clock, not from the previous value: a jump in time shows at once when the tab becomes visible again", async () => {
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(rows()[0][2]).toBe("3mo 12d 12h 0m 0s")

    // The tab is hidden: ticking stops (a background tab would throttle it anyway), and 10 minutes pass with no timer firing.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    const hiddenTimers = vi.getTimerCount()
    vi.setSystemTime(NOW_MS + 10 * 60 * 1000)
    expect(rows()[0][2]).toBe("3mo 12d 12h 0m 0s")

    // Visible again: the true remaining time is shown immediately, without waiting for the next tick, and ticking resumes.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(rows()[0][2]).toBe("3mo 12d 11h 50m 0s")
    expect(vi.getTimerCount()).toBeGreaterThan(hiddenTimers)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1005)
    })
    expect(rows()[0][2]).toBe("3mo 12d 11h 49m 59s")
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("also recomputes at once when the window regains focus", async () => {
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    vi.setSystemTime(NOW_MS + 30 * 1000)
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(rows()[0][2]).toBe("3mo 12d 11h 59m 30s")
  })

describe("celebration day: the countdown is replaced by the localized Today label for the whole JST day", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  })

  /** Both rows' countdown cells at the current fake time, after letting the mocked milestones load. */
  const countdowns = () => rows().map((row) => row[2])
  const labels = () => rows().map((row) => row[0])
  const settle = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  const openAt = async (instant: number, locale = "en") => {
    localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    vi.setSystemTime(instant)
    renderPanel()
    fireEvent.click(trigger(), { detail: 0 })
    await settle()
  }

  it("birthday: one second before JST midnight it counts, at exactly midnight it becomes Today without a refresh or another request", async () => {
    await openAt(jst(2027, 1, 30, 23, 59, 59))
    expect(countdowns()[0]).toBe("0m 1s")
    // The next tick lands just after the wall-clock second boundary: JST midnight.
    await settle(1005)
    expect(countdowns()[0]).toBe("Today")
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("birthday: Today stays for the entire JST day, 00:00:00 through 23:59:59, and the date column keeps the date", async () => {
    await openAt(jst(2027, 1, 31, 0, 0, 0))
    expect(countdowns()[0]).toBe("Today")
    expect(rows()[0][1]).toBe("Jan 31")
    vi.setSystemTime(jst(2027, 1, 31, 12, 0, 0))
    await settle(1005)
    expect(countdowns()[0]).toBe("Today")
    // The fake clock advances with the timers: 23:59:58 + 1.005 s is the last second of the day, 23:59:59.
    vi.setSystemTime(jst(2027, 1, 31, 23, 59, 58))
    await settle(1005)
    expect(countdowns()[0]).toBe("Today")
  })

  it("birthday: at the following JST midnight it resumes counting down to next year", async () => {
    await openAt(jst(2027, 1, 31, 23, 59, 59))
    expect(countdowns()[0]).toBe("Today")
    // 23:59:59 + 1.005 s is the following JST midnight.
    await settle(1005)
    expect(countdowns()[0]).toBe("11mo 30d 0m 0s")
    expect(rows()[0][1]).toBe("Jan 31")
  })

  it("anniversary: the number stays all celebration day, then rolls over at the following JST midnight, independently of the birthday", async () => {
    await openAt(jst(2027, 9, 17, 23, 59, 59))
    expect(rows()[1].slice(0, 1)).toEqual(["6th Anniversary"])
    expect(countdowns()[1]).toBe("0m 1s")
    await settle(1005)
    expect(labels()[1]).toBe("6th Anniversary")
    expect(countdowns()[1]).toBe("Today")
    // The birthday row is unaffected by the anniversary day: it keeps counting.
    expect(countdowns()[0]).not.toBe("Today")

    vi.setSystemTime(jst(2027, 9, 18, 23, 59, 58))
    await settle(1005)
    expect(labels()[1]).toBe("6th Anniversary")
    expect(countdowns()[1]).toBe("Today")

    // The next second is the following JST midnight: the number advances and the countdown resumes toward next year.
    await settle(1000)
    expect(labels()[1]).toBe("7th Anniversary")
    expect(countdowns()[1]).toBe("11mo 30d 0m 0s")
    expect(rows()[1][1]).toBe("Sep 18")
  })

  it("birthday day does not turn the anniversary row into Today", async () => {
    await openAt(jst(2027, 1, 31, 12, 0, 0))
    expect(countdowns()[0]).toBe("Today")
    expect(countdowns()[1]).not.toBe("Today")
  })

  it("a tab returning from the background shows the right state at once: Today, then the next countdown after the day", async () => {
    await openAt(jst(2027, 1, 30, 12, 0, 0))
    expect(countdowns()[0]).not.toBe("Today")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    // Hours later, inside the celebration day, with no timer having fired in the background.
    vi.setSystemTime(jst(2027, 1, 31, 15, 0, 0))
    expect(countdowns()[0]).not.toBe("Today")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(countdowns()[0]).toBe("Today")

    // Away again, back after the day ended: the next-year countdown is shown immediately, with no stale Today.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    vi.setSystemTime(jst(2027, 2, 2, 0, 0, 0))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(countdowns()[0]).toBe("11mo 29d 0m 0s")
  })

  it.each([
    ["en", "Today"],
    ["ja", "当日"],
    ["zh-TW", "當日"],
  ] as const)("%s: the label is %s", async (locale, expected) => {
    await openAt(jst(2027, 1, 31, 9, 0, 0), locale)
    expect(countdowns()[0]).toBe(expected)
  })

  it("Feb 29 policy still applies: a common-year Feb 28 shows Today while the date stays Feb 29", async () => {
    loadMock.mockResolvedValue(found({ creatorId: "hakos_baelz", birthday: "02-29", debutDate: "2021-08-23" }))
    localStorage.setItem("yobi.locale", "en")
    resetAllSharedStateForTests()
    vi.setSystemTime(jst(2027, 2, 28, 10, 0, 0))
    renderPanel("ch_hakos_baelz")
    fireEvent.click(trigger(), { detail: 0 })
    await settle()
    expect(rows()[0]).toEqual(["Birthday", "Feb 29", "Today"])
  })
})})