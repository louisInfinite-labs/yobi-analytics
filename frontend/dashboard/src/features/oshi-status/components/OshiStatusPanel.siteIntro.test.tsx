/** Home's site identity in the status column: the page heading (HomeSiteHeading: the site's name as the page's <h1>) is the column's first block
 * at every width, above the creator header, whose creator name is a heading one level below. The "About OshiYobi" feature list closes the
 * column on tablet/phone, where Latest Activity is a fixed 6-row preview and the page itself scrolls; it is not on desktop, where Latest
 * Activity pages on through the whole feed inside the column's own scroll box (so nothing after it could be reached). The API never answers
 * here: none of it may depend on API data. */
import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OshiStatusPanel } from "./OshiStatusPanel"
import * as useLastVisit from "../hooks/useLastVisit"
import { fetchOshiStatus } from "../data/oshiStatus"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
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

const now = new Date(2026, 8, 10, 12, 0, 0)
const initialWidth = window.innerWidth

/** A feed that is still loading and never answers: the section must not depend on it. */
function feed(): HomeAllFeed {
  const page = { videos: [], loading: true, error: null, loadMore: vi.fn(), hasMore: true }
  return { ...page, page }
}

function renderPanel(width: number) {
  window.innerWidth = width
  render(<OshiStatusPanel creatorId="ch_aizawa_ema" status={{ kind: "offline" }} feed={feed()} now={now} onSelectVideo={vi.fn()} nowPlayingTitle={null} />)
}

/** The status column's direct children, as "intro" / "recent" / "other", in order. */
function columnOrder(): string[] {
  const body = document.querySelector(".oshi-status__body")
  return [...(body?.children ?? [])].map((el) =>
    el.classList.contains("home-site-intro") ? "intro" : el.classList.contains("oshi-status__section--recent") ? "recent" : "other",
  )
}

beforeEach(() => {
  vi.mocked(fetchOshiStatus).mockReset()
  vi.mocked(fetchOshiStatus).mockReturnValue(new Promise(() => undefined))
  vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
  window.localStorage.clear()
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  window.history.pushState({}, "", "/")
})

afterEach(() => {
  window.innerWidth = initialWidth
})

describe("site identity in the status column", () => {
  it.each([1280, 800, 412])("width %i: the site heading is the panel's first block and the page's one <h1>; the creator name is an <h2>", (width) => {
    renderPanel(width)
    const panel = document.querySelector(".oshi-status")!
    expect(panel.firstElementChild).toHaveClass("home-site-heading")
    const h1 = screen.getAllByRole("heading", { level: 1 })
    expect(h1).toHaveLength(1)
    expect(h1[0]).toHaveTextContent("OshiYobi – 推しが呼んでる。")
    expect(screen.getByRole("heading", { level: 2, name: "藍沢エマ" })).toHaveClass("oshi-status__creator-name")
  })

  it("desktop: no feature list in the column (the heading already describes the site and links the pages)", () => {
    renderPanel(1280)
    expect(columnOrder()).toEqual(["other", "other", "other", "recent"])
    expect(document.querySelector(".home-site-intro")).toBeNull()
  })

  it.each([800, 412])("width %i: the feature list closes the column after the 6-row preview", (width) => {
    renderPanel(width)
    expect(columnOrder()).toEqual(["other", "other", "other", "recent", "intro"])
    expect(screen.getByRole("region", { name: "About OshiYobi" }).querySelectorAll("li")).toHaveLength(4)
  })

  it("no link in the panel points at a creator URL", () => {
    renderPanel(800)
    expect(document.querySelector('.oshi-status a[href^="/creator"]')).toBeNull()
  })
})
