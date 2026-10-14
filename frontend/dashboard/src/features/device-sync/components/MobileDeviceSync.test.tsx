import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MobileDeviceSync } from "./MobileDeviceSync"
import * as deviceSyncApi from "../api/deviceSyncApi"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../api/deviceSyncApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/deviceSyncApi")>()),
  getThisDeviceId: vi.fn(() => "device-phone-1"),
  createPairingSession: vi.fn(),
  consumePairingSession: vi.fn(),
  listDeviceSyncSiblings: vi.fn(),
  deleteDeviceSyncSibling: vi.fn(),
}))

const createPairingSession = vi.mocked(deviceSyncApi.createPairingSession)
const consumePairingSession = vi.mocked(deviceSyncApi.consumePairingSession)
const listDeviceSyncSiblings = vi.mocked(deviceSyncApi.listDeviceSyncSiblings)

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  listDeviceSyncSiblings.mockReset().mockResolvedValue({ profileId: null, devices: [] })
  createPairingSession.mockReset().mockResolvedValue({ token: "tok-abc", humanCode: "ABCD-EFGH", expiresAt: 9999999999 })
  consumePairingSession.mockReset().mockResolvedValue({ profileId: "profile-1" })
})

describe("MobileDeviceSync", () => {
  it("shows Scan QR Code and Enter sync code as the primary actions -- never a QR-display-first flow", async () => {
    render(<MobileDeviceSync platform="android-pwa" />)

    expect(await screen.findByRole("button", { name: "Scan QR Code" })).toBeInTheDocument()
    expect(screen.getByLabelText("Enter sync code")).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "QR" })).not.toBeInTheDocument()
  })

  it("shows onboarding guidance when this device is not yet attached to any profile", async () => {
    render(<MobileDeviceSync platform="ios-pwa" />)

    expect(await screen.findByText("Already have another device?")).toBeInTheDocument()
  })

  it("hides the onboarding prompt and offers Generate sync code once this device belongs to a profile", async () => {
    listDeviceSyncSiblings.mockResolvedValue({ profileId: "profile-1", devices: [] })
    render(<MobileDeviceSync platform="android-pwa" />)

    expect(await screen.findByRole("button", { name: "Generate sync code" })).toBeInTheDocument()
    expect(screen.queryByText("Already have another device?")).not.toBeInTheDocument()
  })

  it("never offers Generate sync code before this device belongs to a profile", async () => {
    render(<MobileDeviceSync platform="android-pwa" />)

    await screen.findByRole("button", { name: "Scan QR Code" })
    expect(screen.queryByRole("button", { name: "Generate sync code" })).not.toBeInTheDocument()
  })

  it("entering a code redeems it with this platform's device type (ios)", async () => {
    const user = userEvent.setup()
    render(<MobileDeviceSync platform="ios-pwa" />)

    await user.type(await screen.findByLabelText("Enter sync code"), "abcd-efgh")
    await user.click(screen.getByRole("button", { name: "Enter sync code" }))

    await waitFor(() => expect(consumePairingSession).toHaveBeenCalledWith({ code: "abcd-efgh" }, expect.any(String), "ios"))
  })

  it("clicking Generate sync code (already paired) shows a human code, not a QR", async () => {
    listDeviceSyncSiblings.mockResolvedValue({ profileId: "profile-1", devices: [] })
    const user = userEvent.setup()
    render(<MobileDeviceSync platform="android-pwa" />)

    await user.click(await screen.findByRole("button", { name: "Generate sync code" }))

    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "QR" })).not.toBeInTheDocument()
  })
})
