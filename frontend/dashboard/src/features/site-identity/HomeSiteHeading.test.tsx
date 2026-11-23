/** Home's page heading: the site's own name is the page's <h1>, what OshiYobi is, the page links, and a live line built only from the shared
 * /live-streams data -- a neutral dash until that data has answered in this session (or when it failed), never an invented status. */
import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { HomeSiteHeading } from "./HomeSiteHeading"
import { liveSummaryLines } from "./liveSummary"
import { SITE_INTRO_COPY } from "./siteIntroCopy"
import * as useCreatorStatusesModule from "../live-status/hooks/useCreatorStatuses"
import type { CreatorStatus } from "../live-status/model/creatorStatus"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

vi.mock("../live-status/hooks/useCreatorStatuses", () => ({ useCreatorStatuses: vi.fn() }))

const now = new Date("2026-11-09T12:00:00+09:00")
const roster = getCreators()
const live = (title = "stream"): CreatorStatus => ({ kind: "live", videoId: "LIVE0000001", title })
const upcoming: CreatorStatus = { kind: "upcoming", videoId: "NEXT0000001", title: "next", scheduledStart: "2026-11-09T15:00:00+09:00" }

function statusesWith(entries: [number, CreatorStatus][]): Record<string, CreatorStatus> {
  const statuses: Record<string, CreatorStatus> = Object.fromEntries(roster.map((creator) => [toLegacyRosterId(creator), { kind: "offline" } as CreatorStatus]))
  for (const [index, status] of entries) statuses[toLegacyRosterId(roster[index])] = status
  return statuses
}

function mockStatuses(statuses: Record<string, CreatorStatus>, statusKnown: boolean) {
  vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({ statuses, now, statusKnown })
}

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("HomeSiteHeading", () => {
  it("the page's one <h1> is the site's own name, the same words as the static HTML's <h1>", () => {
    mockStatuses(statusesWith([]), true)
    render(<HomeSiteHeading />)
    const headings = screen.getAllByRole("heading", { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent("OshiYobi – 推しが呼んでる。")
  })

  it("says what OshiYobi is and links Schedule, Settings and About -- never a creator URL", () => {
    mockStatuses(statusesWith([]), true)
    render(<HomeSiteHeading />)
    const section = screen.getByRole("region", { name: "OshiYobi – 推しが呼んでる。" })
    expect(section).toHaveTextContent(SITE_INTRO_COPY.en.lead)
    expect(within(section).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/schedule", "/setting", "/about"])
    expect(section.querySelector('a[href^="/creator"]')).toBeNull()
  })

  it("before the live data has answered (or when it failed): a neutral dash, no names, no counts", () => {
    mockStatuses(statusesWith([[0, live()]]), false)
    render(<HomeSiteHeading />)
    expect(screen.getByText("Live now: —")).toBeInTheDocument()
    expect(screen.queryByText(/Starting within 24 hours/)).toBeNull()
    expect(document.body).not.toHaveTextContent(roster[0].displayName)
  })

  it("with live data: who is live (by name, roster order) and how many start within 24 hours", () => {
    mockStatuses(statusesWith([[3, live()], [1, live()], [2, upcoming]]), true)
    render(<HomeSiteHeading />)
    expect(screen.getByText(`Live now (2): ${roster[1].displayName}, ${roster[3].displayName}`)).toBeInTheDocument()
    expect(screen.getByText("Starting within 24 hours: 1")).toBeInTheDocument()
  })

  it("nobody live: says so, and still counts what starts soon", () => {
    mockStatuses(statusesWith([[2, upcoming]]), true)
    render(<HomeSiteHeading />)
    expect(screen.getByText("No creator is live right now.")).toBeInTheDocument()
    expect(screen.getByText("Starting within 24 hours: 1")).toBeInTheDocument()
  })

  it.each(["zh-TW", "ja"] as const)("is written in %s too", (locale) => {
    window.localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    mockStatuses(statusesWith([]), false)
    render(<HomeSiteHeading />)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("OshiYobi – 推しが呼んでる。")
    expect(screen.getByText(SITE_INTRO_COPY[locale].liveUnknown)).toBeInTheDocument()
  })
})

describe("liveSummaryLines", () => {
  it("names at most six live creators and counts the rest", () => {
    const lines = liveSummaryLines(statusesWith([0, 1, 2, 3, 4, 5, 6, 7].map((index) => [index, live()] as [number, CreatorStatus])), true, SITE_INTRO_COPY.en)
    const names = roster.slice(0, 6).map((creator) => creator.displayName.replace(/\n/g, " "))
    expect(lines[0]).toBe(`Live now (8): ${names.join(", ")}, and 2 more`)
  })
})
