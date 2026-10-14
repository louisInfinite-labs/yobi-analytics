import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AndroidBrowserGuidance } from "./AndroidBrowserGuidance"
import { resetInstallStateForTests } from "../../pwa/installState"

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "en")
  resetInstallStateForTests()
})
afterEach(() => {
  resetInstallStateForTests()
  Reflect.deleteProperty(navigator, "standalone")
  vi.restoreAllMocks()
})

function fireBeforeInstallPrompt() {
  const prompt = vi.fn(async () => undefined)
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: "accepted" as const }) })
  act(() => {
    window.dispatchEvent(event)
  })
  return { prompt }
}

describe("AndroidBrowserGuidance", () => {
  it("shows install guidance, never a QR, scanner, or pairing UI", () => {
    render(<AndroidBrowserGuidance />)

    expect(screen.getByText(/install OshiYobi first/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /scan qr/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "QR" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/enter sync code/i)).not.toBeInTheDocument()
  })

  it("offers the native install button when the browser provides one, and triggers it on click", async () => {
    const user = userEvent.setup()
    render(<AndroidBrowserGuidance />)
    const { prompt } = fireBeforeInstallPrompt()

    await user.click(await screen.findByRole("button", { name: "Install" }))

    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("shows no install button at all when the browser offers no install path", () => {
    render(<AndroidBrowserGuidance />)

    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument()
  })
})
