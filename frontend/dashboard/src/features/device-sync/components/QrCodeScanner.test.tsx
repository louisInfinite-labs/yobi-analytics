import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QrCodeScanner, decodeFrame } from "./QrCodeScanner"

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "en")
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, "mediaDevices")
})

describe("QrCodeScanner camera-permission gating", () => {
  it("never calls getUserMedia on mount", () => {
    const getUserMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true })

    render(<QrCodeScanner onDecoded={vi.fn()} />)

    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it("requests the camera only after the user taps Scan QR Code", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true })
    const user = userEvent.setup()
    render(<QrCodeScanner onDecoded={vi.fn()} />)

    expect(getUserMedia).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Scan QR Code" }))

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "environment" } })
  })

  it("falls back to the manual code entry message when the browser has no camera API at all (no mediaDevices)", async () => {
    const user = userEvent.setup()
    render(<QrCodeScanner onDecoded={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Scan QR Code" }))

    expect(await screen.findByText("Camera unavailable — use the sync code instead")).toBeInTheDocument()
  })

  it("falls back to the same message when permission is denied", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"))
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true })
    const user = userEvent.setup()
    render(<QrCodeScanner onDecoded={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Scan QR Code" }))

    expect(await screen.findByText("Camera unavailable — use the sync code instead")).toBeInTheDocument()
  })
})

describe("decodeFrame (jsqr fallback path, pure function)", () => {
  it("returns null for a blank frame", () => {
    // jsdom has no global ImageData constructor -- jsqr only reads data/width/height, so a plain object of that
    // shape (all-zero, i.e. a blank/black frame) exercises the same "nothing found" path a real one would.
    const blank = { data: new Uint8ClampedArray(10 * 10 * 4), width: 10, height: 10 } as ImageData
    expect(decodeFrame(blank)).toBeNull()
  })
})
