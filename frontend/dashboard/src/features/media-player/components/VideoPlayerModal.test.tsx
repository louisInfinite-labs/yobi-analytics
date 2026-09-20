import { render, screen } from "@testing-library/react"
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
})
