import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useSwipeToFavorite } from "./useSwipeToFavorite"

function Harness({ isFavorite, onCommit }: { isFavorite: boolean; onCommit: () => void }) {
  const swipe = useSwipeToFavorite(isFavorite, onCommit)
  return (
    <div
      data-testid="row"
      {...swipe.rowHandlers}
      data-translate-x={swipe.translateX}
      data-reveal-side={swipe.revealSide ?? "none"}
      data-reveal-opacity={swipe.revealOpacity}
      data-snapping={swipe.isSnapping}
    />
  )
}

function down(el: HTMLElement, clientX: number, clientY = 0) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX, clientY })
}
function move(el: HTMLElement, clientX: number, clientY = 0) {
  fireEvent.pointerMove(el, { pointerId: 1, clientX, clientY })
}
function up(el: HTMLElement, clientX: number, clientY = 0) {
  fireEvent.pointerUp(el, { pointerId: 1, clientX, clientY })
}

describe("useSwipeToFavorite", () => {
  it("A: not favorited, drag +71px, release -> favorite NOT committed, row snaps to 0", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={false} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, 71)
    up(row, 71)
    expect(onCommit).not.toHaveBeenCalled()
    expect(row.dataset.translateX).toBe("0")
  })

  it("B: not favorited, drag +72px, release -> favorite becomes true (committed)", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={false} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, 72)
    up(row, 72)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(row.dataset.translateX).toBe("0") // commit still snaps back to rest
  })

  it("C: not favorited, drag beyond +96px -> visual translation capped at +96", () => {
    render(<Harness isFavorite={false} onCommit={vi.fn()} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, 500)
    expect(row.dataset.translateX).toBe("96")
  })

  it("D: favorited, drag -71px, release -> favorite remains true (NOT committed)", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={true} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, -71)
    up(row, -71)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("E: favorited, drag -72px, release -> favorite becomes false (committed)", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={true} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, -72)
    up(row, -72)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("F: favorited, drag beyond -96px -> visual translation capped at -96", () => {
    render(<Harness isFavorite={true} onCommit={vi.fn()} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, -500)
    expect(row.dataset.translateX).toBe("-96")
  })

  it("G: not favorited, drag LEFT (invalid direction) -> x0.25 resistance capped at -16px, no action", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={false} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, -40)
    expect(row.dataset.translateX).toBe("-10") // -40 * 0.25
    expect(row.dataset.revealSide).toBe("none")
    move(row, -1000)
    expect(row.dataset.translateX).toBe("-16") // capped
    up(row, -1000)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("H: favorited, drag RIGHT (invalid direction) -> x0.25 resistance capped at +16px, no action", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={true} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, 40)
    expect(row.dataset.translateX).toBe("10")
    expect(row.dataset.revealSide).toBe("none")
    move(row, 1000)
    expect(row.dataset.translateX).toBe("16") // capped
    up(row, 1000)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("I: a dominant vertical drag cancels horizontal recognition -- favorite unchanged, vertical scroll not blocked", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={false} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0, 0)
    // deltaY(20) > 12 AND abs(deltaY) > abs(deltaX)(5) -> classified vertical
    move(row, 5, 20)
    expect(row.dataset.translateX).toBe("0")
    move(row, 5, 80) // further movement on the same pointer is ignored for this row
    expect(row.dataset.translateX).toBe("0")
    up(row, 5, 80)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("reveal opacity is 0.65 below the 72px commit threshold and 1 at/above it", () => {
    render(<Harness isFavorite={false} onCommit={vi.fn()} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, 50)
    expect(row.dataset.revealOpacity).toBe("0.65")
    move(row, 72)
    expect(row.dataset.revealOpacity).toBe("1")
  })

  it("does not add a transition (isSnapping) while actively dragging, only after release", () => {
    render(<Harness isFavorite={false} onCommit={vi.fn()} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, 50)
    expect(row.dataset.snapping).toBe("false")
    up(row, 50)
    expect(row.dataset.snapping).toBe("true")
  })

  it("a pointercancel snaps back without committing, even past the threshold", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={false} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    down(row, 0)
    move(row, 90)
    fireEvent.pointerCancel(row, { pointerId: 1 })
    expect(onCommit).not.toHaveBeenCalled()
    expect(row.dataset.translateX).toBe("0")
  })

  it("ignores a second pointer while one gesture is already active on the row", () => {
    const onCommit = vi.fn()
    render(<Harness isFavorite={false} onCommit={onCommit} />)
    const row = screen.getByTestId("row")
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerDown(row, { pointerId: 2, clientX: 0, clientY: 0 }) // ignored
    fireEvent.pointerMove(row, { pointerId: 2, clientX: 90, clientY: 0 }) // ignored (wrong pointer)
    expect(row.dataset.translateX).toBe("0")
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 80, clientY: 0 })
    expect(row.dataset.translateX).toBe("80")
  })
})
