export interface OverlayRect {
  top: number
  left: number
  width: number
  bottom: number
}

export interface OverlayGeometry {
  top: number
  left: number
  width: number
  height: number
}

interface OverlayGeometryInput {
  /** The Oshi Status panel border box (getBoundingClientRect). */
  panel: OverlayRect
  /** The panel border widths (clientTop/clientLeft): an absolutely positioned child starts at the PADDING box, inside the border. */
  panelBorderTop: number
  panelBorderLeft: number
  /** The rendered Now Playing section (getBoundingClientRect): the overlay covers exactly this vertical span and nothing else. */
  nowPlaying: { top: number; bottom: number }
  /** Desktop: the dialog is exactly as wide as the panel. Otherwise (stacked mobile/tablet layout): as wide as the viewport. */
  matchPanelWidth: boolean
  viewportWidth: number
}

/** Where the overlay goes, in px relative to the panel padding box (the containing block of the absolutely positioned dialog), from the
 * REAL rendered rectangles -- never a hardcoded size. Vertically it is exactly the Now Playing section: its top edge (directly below the
 * creator header, which therefore stays fully visible) to its bottom edge. Because it is positioned inside the panel it overlays the content
 * and never moves or resizes anything. */
export function computeOverlayGeometry(input: OverlayGeometryInput): OverlayGeometry {
  const { panel, panelBorderTop, panelBorderLeft, nowPlaying, matchPanelWidth, viewportWidth } = input
  const top = nowPlaying.top - (panel.top + panelBorderTop)
  const height = Math.max(0, nowPlaying.bottom - nowPlaying.top)
  if (matchPanelWidth) return { top, left: -panelBorderLeft, width: panel.width, height }
  return { top, left: -(panel.left + panelBorderLeft), width: viewportWidth, height }
}