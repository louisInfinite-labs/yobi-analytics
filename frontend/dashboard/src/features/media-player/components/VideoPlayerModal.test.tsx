import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { VideoPlayerModal } from "./VideoPlayerModal"

describe("VideoPlayerModal", () => {
  it("pulls focus back into the panel when it lands on a background element", () => {
    // Simulates what a Tab press escaping the cross-origin YouTube iframe
    // would do -- jsdom can't actually load/tab through a real iframe
    // document, but the fix reacts to focus *landing* outside the panel
    // regardless of what put it there, so focusing a background element
    // directly reproduces the same case the fix guards against.
    render(
      <>
        <button>background control</button>
        <VideoPlayerModal videoId="abc123" title="Test video" onClose={vi.fn()} />
      </>,
    )

    // jsdom's .focus() itself synchronously dispatches a real, bubbling
    // focusin event -- the fix's document-level listener reacts to that
    // immediately, so by the time .focus() returns, focus is already back
    // on the close button rather than settled on `background`.
    const background = screen.getByRole("button", { name: "background control" })
    background.focus()

    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close video player/i }))
    expect(document.activeElement).not.toBe(background)
  })

  it("keeps the close button and visible title in the standard variant", () => {
    render(<VideoPlayerModal videoId="abc123" title="Test video" onClose={vi.fn()} />)

    expect(screen.getByRole("button", { name: /close video player/i })).toBeInTheDocument()
    expect(screen.getByText("Test video")).toBeInTheDocument()
  })

  describe("player-only variant", () => {
    it("renders only the 16:9 player iframe: no close button and no visible title", () => {
      const { container } = render(<VideoPlayerModal videoId="abc123" title="Test video" variant="player-only" onClose={vi.fn()} />)

      expect(screen.queryByRole("button")).not.toBeInTheDocument()
      expect(screen.queryByText("Test video")).not.toBeInTheDocument()
      expect(container.ownerDocument.querySelectorAll("iframe")).toHaveLength(1)
      expect(container.ownerDocument.querySelector(".video-player-modal__title")).toBeNull()
    })

    it("closes on a backdrop click but not on a click inside the player", () => {
      const onClose = vi.fn()
      render(<VideoPlayerModal videoId="abc123" title="Test video" variant="player-only" onClose={onClose} />)

      fireEvent.click(document.querySelector(".video-player-modal__frame")!)
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.click(document.querySelector(".video-player-modal__backdrop")!)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it("still closes on Escape, with focus starting on the panel", () => {
      const onClose = vi.fn()
      render(<VideoPlayerModal videoId="abc123" title="Test video" variant="player-only" onClose={onClose} />)

      expect(document.activeElement).toBe(document.querySelector(".video-player-modal__panel"))
      fireEvent.keyDown(document, { key: "Escape" })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it("pulls focus back to the panel when it lands on a background element", () => {
      render(
        <>
          <button>background control</button>
          <VideoPlayerModal videoId="abc123" title="Test video" variant="player-only" onClose={vi.fn()} />
        </>,
      )
      screen.getByRole("button", { name: "background control" }).focus()

      expect(document.activeElement).toBe(document.querySelector(".video-player-modal__panel"))
    })
  })
})
