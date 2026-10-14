import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import QRCode from "qrcode"
import { QrCodeDisplay } from "./QrCodeDisplay"

vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn() } }))

describe("QrCodeDisplay", () => {
  it("renders the pairing token's value to the canvas via the qrcode library", async () => {
    const toCanvas = vi.mocked(QRCode.toCanvas).mockResolvedValue(undefined as never)

    render(<QrCodeDisplay value="pairing-token-123" size={200} />)

    await waitFor(() => expect(toCanvas).toHaveBeenCalled())
    const [, value, options] = toCanvas.mock.calls[0]
    expect(value).toBe("pairing-token-123")
    expect(options).toMatchObject({ width: 200 })
  })

  it("falls back to a visible error placeholder (never a blank box) if generation fails", async () => {
    vi.mocked(QRCode.toCanvas).mockRejectedValue(new Error("boom"))

    const { container } = render(<QrCodeDisplay value="x" />)

    await waitFor(() => expect(container.querySelector(".device-sync-qr--error")).toBeInTheDocument())
  })
})
