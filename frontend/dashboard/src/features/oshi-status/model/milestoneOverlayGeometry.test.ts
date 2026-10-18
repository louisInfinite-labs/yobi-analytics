import { describe, expect, it } from "vitest"
import { computeOverlayGeometry } from "./milestoneOverlayGeometry"

const PANEL = { top: 100, left: 16, width: 300, bottom: 700 }
const NOW_PLAYING = { top: 170, bottom: 330 }

describe("computeOverlayGeometry", () => {
  it("desktop: exactly the panel width, spanning exactly the Now Playing section (top edge to bottom edge)", () => {
    expect(computeOverlayGeometry({ panel: PANEL, panelBorderTop: 1, panelBorderLeft: 1, nowPlaying: NOW_PLAYING, matchPanelWidth: true, viewportWidth: 1280 })).toEqual({
      top: 69,
      left: -1,
      width: 300,
      height: 160,
    })
  })

  it("mobile: the viewport width, starting at the viewport edge, still only the Now Playing span", () => {
    expect(computeOverlayGeometry({ panel: PANEL, panelBorderTop: 1, panelBorderLeft: 1, nowPlaying: NOW_PLAYING, matchPanelWidth: false, viewportWidth: 390 })).toEqual({
      top: 69,
      left: -17,
      width: 390,
      height: 160,
    })
  })

  it("never reaches above the Now Playing top: the creator header above it is not covered", () => {
    const geometry = computeOverlayGeometry({ panel: PANEL, panelBorderTop: 1, panelBorderLeft: 1, nowPlaying: NOW_PLAYING, matchPanelWidth: true, viewportWidth: 1280 })
    // In viewport terms the overlay top is the panel padding-box top plus its offset: exactly the Now Playing top.
    expect(PANEL.top + 1 + geometry.top).toBe(NOW_PLAYING.top)
    expect(PANEL.top + 1 + geometry.top + geometry.height).toBe(NOW_PLAYING.bottom)
  })

  it("the height is the real rendered height of the section", () => {
    const at = (bottom: number) => computeOverlayGeometry({ panel: PANEL, panelBorderTop: 0, panelBorderLeft: 0, nowPlaying: { top: 170, bottom }, matchPanelWidth: true, viewportWidth: 1280 }).height
    expect(at(230)).toBe(60)
    expect(at(390)).toBe(220)
  })

  it("never goes negative", () => {
    expect(computeOverlayGeometry({ panel: PANEL, panelBorderTop: 0, panelBorderLeft: 0, nowPlaying: { top: 170, bottom: 150 }, matchPanelWidth: true, viewportWidth: 1280 }).height).toBe(0)
  })
})