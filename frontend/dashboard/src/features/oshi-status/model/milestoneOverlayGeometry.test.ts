import { describe, expect, it } from "vitest"
import { computeOverlayGeometry } from "./milestoneOverlayGeometry"

const PANEL = { top: 100, left: 16, width: 300, bottom: 700 }
const NOW_PLAYING = { top: 170, bottom: 330 }

describe("computeOverlayGeometry", () => {
  it("exactly the panel border-box width, spanning exactly the Now Playing section (top edge to bottom edge)", () => {
    expect(computeOverlayGeometry({ panel: PANEL, panelBorderTop: 1, panelBorderLeft: 1, nowPlaying: NOW_PLAYING })).toEqual({
      top: 69,
      left: -1,
      width: 300,
      height: 160,
    })
  })

  it("stacked mobile/tablet layout: the same left and right edges as the panel (its side margins), never the viewport edges", () => {
    // A 390px viewport with a 16px side margin: the panel is 358px wide at left 16.
    const panel = { top: 100, left: 16, width: 358, bottom: 700 }
    const geometry = computeOverlayGeometry({ panel, panelBorderTop: 1, panelBorderLeft: 1, nowPlaying: NOW_PLAYING })
    expect(geometry).toEqual({ top: 69, left: -1, width: 358, height: 160 })
    // In viewport terms: the panel padding-box left (16 + 1) plus the offset (-1) is the panel border-box left edge, and the width reaches its right edge.
    expect(panel.left + 1 + geometry.left).toBe(panel.left)
    expect(panel.left + 1 + geometry.left + geometry.width).toBe(panel.left + panel.width)
  })

  it("does not depend on the viewport width: the panel rectangle is the only horizontal input", () => {
    const wide = { top: 100, left: 1084, width: 340, bottom: 700 }
    expect(computeOverlayGeometry({ panel: wide, panelBorderTop: 1, panelBorderLeft: 1, nowPlaying: NOW_PLAYING })).toEqual({ top: 69, left: -1, width: 340, height: 160 })
  })

  it("never reaches above the Now Playing top: the creator header above it is not covered", () => {
    const geometry = computeOverlayGeometry({ panel: PANEL, panelBorderTop: 1, panelBorderLeft: 1, nowPlaying: NOW_PLAYING })
    // In viewport terms the overlay top is the panel padding-box top plus its offset: exactly the Now Playing top.
    expect(PANEL.top + 1 + geometry.top).toBe(NOW_PLAYING.top)
    expect(PANEL.top + 1 + geometry.top + geometry.height).toBe(NOW_PLAYING.bottom)
  })

  it("the height is the real rendered height of the section", () => {
    const at = (bottom: number) => computeOverlayGeometry({ panel: PANEL, panelBorderTop: 0, panelBorderLeft: 0, nowPlaying: { top: 170, bottom } }).height
    expect(at(230)).toBe(60)
    expect(at(390)).toBe(220)
  })

  it("never goes negative", () => {
    expect(computeOverlayGeometry({ panel: PANEL, panelBorderTop: 0, panelBorderLeft: 0, nowPlaying: { top: 170, bottom: 150 } }).height).toBe(0)
  })
})