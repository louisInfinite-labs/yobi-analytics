/** Mobile Home restructure (spec sections 41-44): the normal Video List browsing section
 * (RecentVideosSection) is removed from mobile Home entirely -- it moves to the dedicated Videos page
 * -- and replaced by a compact Search entry point sharing the phone top bar's row with the hamburger.
 * Desktop is unaffected. Heavy data subsystems (Oshi Status, live streams) are stubbed; this file only
 * asserts STRUCTURE (what mounts, what doesn't), not their own internal behavior (covered elsewhere). */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./HomePage"
import { MainNavbar } from "../../app/navigation/MainNavbar"
import { goToPage } from "../../app/navigation/useCurrentPage"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../../features/home-room/components/RecentVideosSection", () => ({
  RecentVideosSection: () => <div data-testid="recent-videos-section" />,
}))
vi.mock("../../features/oshi-status/components/OshiStatusPanel", () => ({
  OshiStatusPanel: () => <div data-testid="oshi-status-panel" />,
}))
vi.mock("../../features/live-status/hooks/useCreatorStatuses", () => ({
  useCreatorStatuses: () => ({ statuses: {}, now: new Date() }),
}))
vi.mock("../../features/live-status/hooks/useLiveDockExpanded", () => ({
  useLiveDockExpanded: () => false,
}))
vi.mock("../../features/home-room/hooks/useRecentVideos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../features/home-room/hooks/useRecentVideos")>()
  return { ...actual, useLiveStreamVideoPool: () => ({ videos: [] }) }
})
vi.mock("../../app/navigation/useCurrentPage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/navigation/useCurrentPage")>()
  return { ...actual, goToPage: vi.fn() }
})

const [CREATOR_A] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

beforeEach(() => {
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](LEGACY_A))
  vi.mocked(goToPage).mockClear()
})

afterEach(() => {
  setWidth(1024)
})

describe("Mobile Home: the normal Video List section is replaced by a Search entry", () => {
  it("renders Player and Oshi Status but NOT the Video List browsing section at phone width", () => {
    setWidth(390)
    render(<HomePage />)
    expect(screen.getByTestId("oshi-status-panel")).toBeInTheDocument()
    expect(document.querySelector(".oshi-stream")).not.toBeNull()
    expect(screen.queryByTestId("recent-videos-section")).not.toBeInTheDocument()
  })

  it("keeps rendering the Video List section at desktop width (desktop is unaffected)", () => {
    setWidth(1280)
    render(<HomePage />)
    expect(screen.getByTestId("recent-videos-section")).toBeInTheDocument()
  })

  it("the Search entry shares the hamburger's own top row (MainNavbar's slot), and tapping it navigates to Videos -- never rendering results under Home", () => {
    setWidth(390)
    render(
      <>
        <MainNavbar />
        <HomePage />
      </>,
    )
    const searchEntry = screen.getByRole("button", { name: /^search$|^搜尋$|^検索$/i })
    expect(searchEntry.closest("#main-topbar-slot")).not.toBeNull()

    fireEvent.click(searchEntry)
    expect(goToPage).toHaveBeenCalledWith("videos")
    expect(screen.queryByTestId("recent-videos-section")).not.toBeInTheDocument()
  })

  it("does not render a Search entry at desktop width", () => {
    setWidth(1280)
    render(<HomePage />)
    expect(screen.queryByRole("button", { name: /^search$|^搜尋$|^検索$/i })).not.toBeInTheDocument()
  })
})
