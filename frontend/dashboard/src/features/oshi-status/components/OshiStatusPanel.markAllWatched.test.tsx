/** 最近動態 的「已觀看全部」: a button at the right end of the section heading that, after the SAME confirmation dialog the Oshi switch uses (message / checkbox /
 * Cancel + confirm), marks every outstanding NEW video seen in the shared seen store -- so the NEW badges and the 尚未觀看 counts update at once and the state survives
 * a reload -- and never touches a livestream archive. "Don't ask again" is remembered only by confirming, and only for this action. */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OshiStatusPanel } from "./OshiStatusPanel"
import * as useLastVisit from "../hooks/useLastVisit"
import { fetchOshiStatus } from "../data/oshiStatus"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import { OshiSwitchConfirmDialog } from "../../oshi/components/OshiSwitchConfirmDialog"
import { startOfLocalDay } from "../../../shared/newContent/newContentTracking"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../hooks/useLastVisit", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useLastVisit")>("../hooks/useLastVisit")
  return { ...actual, usePreviousVisit: vi.fn() }
})
vi.mock("../data/oshiStatus", () => ({ fetchOshiStatus: vi.fn() }))
vi.mock("../data/allCreatorMilestones", async () => {
  const actual = await vi.importActual<typeof import("../data/allCreatorMilestones")>("../data/allCreatorMilestones")
  return { ...actual, getCachedAllCreatorMilestones: vi.fn(() => null), loadAllCreatorMilestones: vi.fn(() => Promise.reject(new Error("not under test"))) }
})

const now = new Date(2026, 8, 10, 12, 0, 0) // local-time constructors: NEW is judged against the browser's own local midnight
const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_KEY = "yobi.newContent.seenVideoIds"
const MARK_ALL_PREFERENCE_KEY = "yobi.confirmMarkAllWatched"
const OSHI_SWITCH_PREFERENCE_KEY = "yobi.confirmOshiSwitch"

interface Item {
  videoId: string
  title: string
  kind: "upload" | "livestream"
}
const upload = (id: string): Item => ({ videoId: id, title: `Upload ${id}`, kind: "upload" })
const livestream = (id: string): Item => ({ videoId: id, title: `Stream ${id}`, kind: "livestream" })
const publishedAt = new Date(2026, 8, 10, 9, 0, 0).toISOString() // after the baseline (today's local 00:00) and before `now`: every fixture row is NEW until seen

function feedFor(items: Item[]): HomeAllFeed {
  const page = {
    videos: items.map((item) => ({
      videoId: item.videoId,
      title: item.title,
      publishedAt,
      thumbnailUrl: null,
      contentFormat: item.kind === "livestream" ? ("live_archive" as const) : ("normal_video" as const),
    })),
    loading: false,
    error: null,
    loadMore: vi.fn(),
    hasMore: false,
    newContent: {
      videoIds: items.filter((item) => item.kind === "upload").map((item) => item.videoId),
      livestreamIds: items.filter((item) => item.kind === "livestream").map((item) => item.videoId),
      unclassifiedIds: [],
    },
  }
  return { ...page, page }
}

let items: Item[] = []
let feedOverride: Partial<HomeAllFeed> = {}

function renderPanel() {
  return render(
    <OshiStatusPanel
      creatorId="ch_aizawa_ema"
      status={{ kind: "offline" }}
      feed={{ ...feedFor(items), ...feedOverride }}
      now={now}
      onSelectVideo={vi.fn()}
      nowPlayingTitle={null}
    />,
  )
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width })
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width })
}

const seen = () => JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]") as string[]
const markAllButton = () => screen.getByRole("button", { name: "已觀看全部" })
const confirmDialog = () => screen.queryByRole("dialog", { name: "已觀看全部新影片嗎?" })
const badgeCount = () => document.querySelectorAll(".oshi-status__recent-new-badge").length
function counts() {
  const section = screen.getByText("尚未觀看").closest("section") as HTMLElement
  return Object.fromEntries(
    Array.from(section.querySelectorAll(".oshi-status__metric")).map((metric) => [metric.querySelector(".oshi-status__metric-label")!.textContent, metric.querySelector(".oshi-status__metric-value")!.textContent]),
  )
}

beforeEach(() => {
  items = [upload("u1"), upload("u2"), livestream("s1")]
  feedOverride = {}
  vi.mocked(fetchOshiStatus).mockReset()
  vi.mocked(fetchOshiStatus).mockResolvedValue({
    subscriberCount: 1000,
    latestVideo: null,
    thisWeek: { newUploads: 0, newStreams: 0 },
    growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
    sinceLastVisit: null,
  })
  vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
  window.localStorage.clear()
  window.localStorage.setItem("yobi.locale", "zh-TW")
  window.localStorage.setItem(BASELINE_KEY, startOfLocalDay(now).toISOString())
  resetAllSharedStateForTests()
  setViewport(1280)
})

afterEach(() => vi.restoreAllMocks())

describe("the 已觀看全部 button", () => {
  it("sits at the right end of the 最近動態 heading row, after the title", async () => {
    renderPanel()
    const head = (await screen.findByText("最近動態")).parentElement as HTMLElement
    expect(head).toHaveClass("oshi-status__section-head")
    expect(head.firstElementChild).toHaveTextContent("最近動態")
    expect(head.lastElementChild).toHaveClass("oshi-status__section-actions")
    expect(within(head.lastElementChild as HTMLElement).getByRole("button", { name: "已觀看全部" })).toBe(markAllButton())
  })

  it("desktop: it is the only control of the heading row; mobile: 查看全部 sits beside it, in the same right-hand group", async () => {
    const desktop = renderPanel()
    await screen.findByText("最近動態")
    expect(within(document.querySelector(".oshi-status__section-actions") as HTMLElement).getAllByRole("button").map((button) => button.textContent)).toEqual(["已觀看全部"])
    desktop.unmount()

    setViewport(390)
    renderPanel()
    await screen.findByText("最近動態")
    expect(within(document.querySelector(".oshi-status__section-actions") as HTMLElement).getAllByRole("button").map((button) => button.textContent)).toEqual(["已觀看全部", "查看全部"])
  })

  it("is unavailable while nothing is outstanding and while the list is still loading", async () => {
    items = [livestream("s1")] // a NEW livestream alone is not something this action marks
    const first = renderPanel()
    await screen.findByText("最近動態")
    expect(markAllButton()).toBeDisabled()
    first.unmount()

    items = [upload("u1")]
    feedOverride = { loading: true, videos: [], newContent: undefined }
    renderPanel()
    expect(markAllButton()).toBeDisabled()
  })

  it("is available when a NEW video is outstanding", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    expect(markAllButton()).toBeEnabled()
  })
})

describe("the confirmation dialog", () => {
  it("opens with the exact text: the question, 以後不再提示 (unchecked) and 取消 / 確定 in that order", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    await userEvent.setup().click(markAllButton())

    const dialog = await screen.findByRole("dialog", { name: "已觀看全部新影片嗎?" })
    expect(within(dialog).getByText("已觀看全部新影片嗎?")).toBeInTheDocument()
    expect(within(dialog).getByRole("checkbox", { name: "以後不再提示" })).not.toBeChecked()
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["取消", "確定"])
  })

  it("is the Oshi switch's own dialog: the same component, container and class names (so size, padding, radius, fonts, checkbox and buttons are identical)", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    await userEvent.setup().click(markAllButton())
    const dialog = await screen.findByRole("dialog", { name: "已觀看全部新影片嗎?" })

    expect(dialog).toHaveClass("oshi-switch-confirm__backdrop")
    expect(dialog.parentElement).toBe(document.body) // portalled like the switch dialog
    expect(dialog.querySelector(".oshi-switch-confirm__panel > .oshi-switch-confirm__message")).not.toBeNull()
    expect(dialog.querySelector(".oshi-switch-confirm__panel > label.oshi-switch-confirm__checkbox-row > input[type=checkbox]")).not.toBeNull()
    expect(dialog.querySelector(".oshi-switch-confirm__panel > .oshi-switch-confirm__actions > .oshi-switch-confirm__cancel")).not.toBeNull()
    expect(dialog.querySelector(".oshi-switch-confirm__panel > .oshi-switch-confirm__actions > .oshi-switch-confirm__confirm")).not.toBeNull()
  })

  it("the Oshi switch dialog is unchanged by the reuse: with no overrides it still asks its own question and confirms with 切換", () => {
    render(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="zh-TW" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("要將畫面切換到「藍沢エマ」嗎？")).toBeInTheDocument()
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["取消", "切換"])
    expect(within(dialog).getByRole("checkbox", { name: "以後不再提示" })).not.toBeChecked()
  })

  it("Esc and a click on the backdrop cancel it, like the switch dialog", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    const user = userEvent.setup()
    await user.click(markAllButton())
    await screen.findByRole("dialog", { name: "已觀看全部新影片嗎?" })
    await user.keyboard("{Escape}")
    expect(confirmDialog()).toBeNull()

    await user.click(markAllButton())
    fireEvent.click(await screen.findByRole("dialog", { name: "已觀看全部新影片嗎?" }))
    expect(confirmDialog()).toBeNull()
    expect(seen()).toEqual([])
  })
})

describe("取消 changes nothing", () => {
  it("closes the dialog, marks nothing, and does not save 以後不再提示 even when it was checked", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    const user = userEvent.setup()
    await user.click(markAllButton())
    await user.click(await screen.findByRole("checkbox", { name: "以後不再提示" }))
    await user.click(screen.getByRole("button", { name: "取消" }))

    expect(confirmDialog()).toBeNull()
    expect(seen()).toEqual([])
    expect(badgeCount()).toBe(3)
    expect(counts()).toEqual({ 影片: "2", 直播: "1" })
    expect(window.localStorage.getItem(MARK_ALL_PREFERENCE_KEY)).toBeNull()

    await user.click(markAllButton()) // it still asks
    expect(await screen.findByRole("dialog", { name: "已觀看全部新影片嗎?" })).toBeInTheDocument()
  })
})

describe("確定 marks every outstanding NEW video seen", () => {
  it("through the shared seen store: the NEW badges and the counts update at once, and a livestream archive stays NEW", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    expect(counts()).toEqual({ 影片: "2", 直播: "1" })
    expect(badgeCount()).toBe(3)

    const user = userEvent.setup()
    await user.click(markAllButton())
    await user.click(await screen.findByRole("button", { name: "確定" }))

    expect(confirmDialog()).toBeNull()
    expect(seen().sort()).toEqual(["u1", "u2"]) // the very store opening a video writes -- no second state system
    expect(counts()).toEqual({ 影片: "0", 直播: "1" })
    expect(badgeCount()).toBe(1)
    const streamRow = screen.getByText("Stream s1").closest(".oshi-status__recent-row")
    expect(streamRow?.querySelector(".oshi-status__recent-new-badge")).not.toBeNull()
    expect(markAllButton()).toBeDisabled() // nothing outstanding any more
  })

  it("marks videos beyond the rows shown too (the whole 尚未觀看 影片 count), and leaves already-seen and unrelated ids alone", async () => {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(["old_seen"]))
    resetAllSharedStateForTests()
    items = [upload("u1")]
    feedOverride = { newContent: { videoIds: ["u1", "not_loaded_1", "not_loaded_2"], livestreamIds: ["s_elsewhere"], unclassifiedIds: ["no_type_yet"] } }
    renderPanel()
    await screen.findByText("Upload u1")
    expect(counts()).toEqual({ 影片: "4", 直播: "1" })

    const user = userEvent.setup()
    await user.click(markAllButton())
    await user.click(await screen.findByRole("button", { name: "確定" }))

    expect(seen().sort()).toEqual(["no_type_yet", "not_loaded_1", "not_loaded_2", "old_seen", "u1"])
    expect(counts()).toEqual({ 影片: "0", 直播: "1" })
  })

  it("survives a reload: the same state is read back, with no NEW video and the same count", async () => {
    const first = renderPanel()
    await screen.findByText("Upload u1")
    const user = userEvent.setup()
    await user.click(markAllButton())
    await user.click(await screen.findByRole("button", { name: "確定" }))
    first.unmount()

    resetAllSharedStateForTests() // a reload: in-memory state is gone, localStorage is not
    renderPanel()
    await screen.findByText("Upload u1")
    expect(counts()).toEqual({ 影片: "0", 直播: "1" })
    expect(badgeCount()).toBe(1)
    expect(seen().sort()).toEqual(["u1", "u2"])
  })

  it("an unchecked 以後不再提示 saves nothing: the next click asks again", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    const user = userEvent.setup()
    await user.click(markAllButton())
    await user.click(await screen.findByRole("button", { name: "確定" }))
    expect(window.localStorage.getItem(MARK_ALL_PREFERENCE_KEY)).toBeNull()
  })
})

describe("以後不再提示", () => {
  it("checked + 確定 saves the preference, marks, and later clicks mark at once with no dialog", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    const user = userEvent.setup()
    await user.click(markAllButton())
    await user.click(await screen.findByRole("checkbox", { name: "以後不再提示" }))
    await user.click(screen.getByRole("button", { name: "確定" }))

    expect(window.localStorage.getItem(MARK_ALL_PREFERENCE_KEY)).toBe("false")
    expect(counts()).toEqual({ 影片: "0", 直播: "1" })

    // A new video arrives later: the next click marks directly.
    items = [upload("u1"), upload("u2"), upload("u3"), livestream("s1")]
    act(() => {
      resetAllSharedStateForTests() // re-read the preference from storage like a fresh load would
    })
    cleanupAndRender()
    await screen.findByText("Upload u3")
    await user.click(markAllButton())
    expect(confirmDialog()).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
    await waitFor(() => expect(seen()).toContain("u3"))
    expect(counts()).toEqual({ 影片: "0", 直播: "1" })
  })

  it("applies only to this action: the Oshi switch confirmation is untouched and its preference key is never written", async () => {
    renderPanel()
    await screen.findByText("Upload u1")
    const user = userEvent.setup()
    await user.click(markAllButton())
    await user.click(await screen.findByRole("checkbox", { name: "以後不再提示" }))
    await user.click(screen.getByRole("button", { name: "確定" }))

    expect(window.localStorage.getItem(MARK_ALL_PREFERENCE_KEY)).toBe("false")
    expect(window.localStorage.getItem(OSHI_SWITCH_PREFERENCE_KEY)).toBeNull() // the creator-switch dialog keeps asking

    render(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="zh-TW" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByText("要將畫面切換到「藍沢エマ」嗎？")).toBeInTheDocument()
  })

  it("and the other way round: opting out of the Oshi switch confirmation does not skip this one", async () => {
    window.localStorage.setItem(OSHI_SWITCH_PREFERENCE_KEY, "false")
    resetAllSharedStateForTests()
    renderPanel()
    await screen.findByText("Upload u1")
    await userEvent.setup().click(markAllButton())
    expect(await screen.findByRole("dialog", { name: "已觀看全部新影片嗎?" })).toBeInTheDocument()
    expect(seen()).toEqual([])
  })
})

describe("the other locales", () => {
  it.each([
    ["en", "Mark all watched", "Mark all new videos as watched?", "Cancel", "OK"],
    ["ja", "すべて視聴済み", "新着動画をすべて視聴済みにしますか?", "キャンセル", "OK"],
  ])("%s: button, question and buttons are translated", async (locale, button, question, cancel, confirm) => {
    window.localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests() // the locale is shared state: read it again
    renderPanel()
    await screen.findByText("Upload u1")
    await userEvent.setup().click(screen.getByRole("button", { name: button }))
    const dialog = await screen.findByRole("dialog", { name: question })
    expect(within(dialog).getAllByRole("button").map((entry) => entry.textContent)).toEqual([cancel, confirm])
  })
})

function cleanupAndRender() {
  document.body.innerHTML = ""
  renderPanel()
}
