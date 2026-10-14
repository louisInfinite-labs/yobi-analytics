import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IosSafariGuidance } from "./IosSafariGuidance"

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "en")
  Object.defineProperty(navigator, "standalone", { value: false, configurable: true })
})
afterEach(() => {
  Reflect.deleteProperty(navigator, "standalone")
  vi.restoreAllMocks()
})

describe("IosSafariGuidance", () => {
  it("shows Add to Home Screen guidance, never a QR, scanner, or pairing UI, with no dialog open by default", () => {
    render(<IosSafariGuidance />)

    expect(screen.getByText(/add OshiYobi to your Home Screen first/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /scan qr/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "QR" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/enter sync code/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("opens the Add-to-Home-Screen steps with the local-data separation warning on click", async () => {
    const user = userEvent.setup()
    render(<IosSafariGuidance />)

    await user.click(screen.getByRole("button", { name: "How to install" }))

    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveTextContent("Add to Home Screen")
    expect(dialog).toHaveTextContent(/local data/i)
  })
})
