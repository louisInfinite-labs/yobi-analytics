import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LiveScheduleDock } from "./LiveScheduleDock"
import * as useCurrentPageModule from "../../../app/navigation/useCurrentPage"
import * as useCreatorStatusesModule from "../hooks/useCreatorStatuses"
import * as useHomeSelectedVideoModule from "../../home-room/hooks/useHomeSelectedVideo"
import type { Page } from "../../../app/navigation/useCurrentPage"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"

vi.mock("../../../app/navigation/useCurrentPage")
vi.mock("../hooks/useCreatorStatuses", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useCreatorStatuses")>("../hooks/useCreatorStatuses")
  return { ...actual, useCreatorStatuses: vi.fn() }
})
vi.mock("../../home-room/hooks/useHomeSelectedVideo", async () => {
  const actual = await vi.importActual<typeof import("../../home-room/hooks/useHomeSelectedVideo")>(
    "../../home-room/hooks/useHomeSelectedVideo",
  )
  return { ...actual, selectHomeVideo: vi.fn() }
})

const now = new Date("2026-09-10T12:00:00+09:00")

function mockPage(page: Page) {
  vi.mocked(useCurrentPageModule.useCurrentPage).mockReturnValue([page, vi.fn()])
}

/** ch_aizawa_ema is currentOshi's own untouched default (mockCreators[0]),
 * so clicking her LIVE status never needs the Oshi-switch confirm flow --
 * this file is only exercising the Home-vs-non-Home player routing (see
 * CreatorStatusList.test.tsx's own "video selection for a different
 * creator" describe block for that separate concern). */
function mockLiveStatuses() {
  vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({
    statuses: { ch_aizawa_ema: { kind: "live", videoId: "v1", title: "t1" } },
    now,
  })
}

/** Targets elements by class rather than accessible name/role: once the
 * drawer is open, jsdom has no real CSS loaded, so the trigger button (kept
 * in the DOM but visually hidden via .live-status-dock[data-live-status-
 * open="true"] .live-status-trigger in home.css) would otherwise still
 * match a role/name query alongside the status pill's own "LIVE" text. */
async function openAndSelectVideo() {
  const user = userEvent.setup()
  await user.click(document.querySelector(".live-status-trigger") as HTMLElement)
  await user.click(document.querySelector('.live-status-member__status[data-status="live"]') as HTMLElement)
}

describe("LiveScheduleDock video selection", () => {
  beforeEach(() => {
    // vi.mock's spies persist their call history across tests in this file
    // (this project's vitest config has no global clearMocks) -- without
    // this, "not.toHaveBeenCalled" in a later test would see an earlier
    // test's calls.
    vi.clearAllMocks()
    mockLiveStatuses()
  })

  it("on Home, routes into the canonical Home player path and never renders VideoPlayerModal", async () => {
    mockPage("home")
    render(<LiveScheduleDock />)
    await openAndSelectVideo()

    // A live/upcoming pick never counts as opened: only a confirmed player PLAYING marks it watched.
    expect(useHomeSelectedVideoModule.selectHomeVideo).toHaveBeenCalledWith(
      { videoId: "v1", title: "t1" },
      "ch_aizawa_ema",
      { countsAsOpened: false },
    )
    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })

  it("off Home, picking a live stream writes no seen state either (only PLAYING counts)", async () => {
    window.localStorage.removeItem("yobi.newContent.seenVideoIds")
    mockPage("dashboard")
    render(<LiveScheduleDock />)
    await openAndSelectVideo()

    expect(document.querySelector(".video-player-modal__backdrop")).not.toBeNull()
    expect(JSON.parse(window.localStorage.getItem("yobi.newContent.seenVideoIds") ?? "[]")).toEqual([])
    expect(window.localStorage.getItem("yobi.newContent.watchedDuringLive")).toBeNull()
  })

  it("closes the drawer after selecting a video on Home", async () => {
    mockPage("home")
    render(<LiveScheduleDock />)
    await openAndSelectVideo()

    expect(document.querySelector('[data-live-status-open="true"]')).toBeNull()
  })

  it("off Home (e.g. Dashboard), still opens the legacy modal instead of the canonical Home path", async () => {
    mockPage("dashboard")
    render(<LiveScheduleDock />)
    await openAndSelectVideo()

    expect(useHomeSelectedVideoModule.selectHomeVideo).not.toHaveBeenCalled()
    expect(document.querySelector(".video-player-modal__backdrop")).not.toBeNull()
  })

  it("on Home, a live official/group channel is selected into the same canonical Home player after the normal switch, never the legacy modal, and picking it is not watching it", async () => {
    const officialId = toLegacyRosterId(getCreatorById("hololive_official")!)
    vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({
      statuses: { [officialId]: { kind: "live", videoId: "vo", title: "official live" } },
      now,
    })
    mockPage("home")
    render(<LiveScheduleDock />)
    const user = userEvent.setup()
    await user.click(document.querySelector(".live-status-trigger") as HTMLElement)
    await user.click(document.querySelector('.live-status-member__status[data-status="live"]') as HTMLElement)
    // The same confirm-before-switch flow an individual creator gets; confirm it.
    await user.click(screen.getByRole("button", { name: /^Switch$/ }))

    // Selecting is not watching: the call carries countsAsOpened:false exactly like an individual creator's.
    expect(useHomeSelectedVideoModule.selectHomeVideo).toHaveBeenCalledWith({ videoId: "vo", title: "official live" }, officialId, {
      countsAsOpened: false,
    })
    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })
})
