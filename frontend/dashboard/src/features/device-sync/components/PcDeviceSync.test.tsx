import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PcDeviceSync } from "./PcDeviceSync"
import * as deviceSyncApi from "../api/deviceSyncApi"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../api/deviceSyncApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/deviceSyncApi")>()),
  getThisDeviceId: vi.fn(() => "device-pc-1"),
  createPairingSession: vi.fn(),
  consumePairingSession: vi.fn(),
  listDeviceSyncSiblings: vi.fn(),
  deleteDeviceSyncSibling: vi.fn(),
}))
// QrCodeDisplay draws to a real <canvas> 2D context, which jsdom does not implement -- its own rendering is
// covered by QrCodeDisplay.test.tsx (mocking the qrcode library directly). This test only needs to know PcDeviceSync
// mounted it with the session's token.
vi.mock("./QrCodeDisplay", () => ({ QrCodeDisplay: ({ value }: { value: string }) => <div role="img" aria-label="QR" data-value={value} /> }))

const createPairingSession = vi.mocked(deviceSyncApi.createPairingSession)
const consumePairingSession = vi.mocked(deviceSyncApi.consumePairingSession)
const listDeviceSyncSiblings = vi.mocked(deviceSyncApi.listDeviceSyncSiblings)
const deleteDeviceSyncSibling = vi.mocked(deviceSyncApi.deleteDeviceSyncSibling)

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  listDeviceSyncSiblings.mockReset().mockResolvedValue({ profileId: null, devices: [] })
  createPairingSession.mockReset().mockResolvedValue({ token: "tok-abc", humanCode: "ABCD-EFGH", expiresAt: 9999999999 })
  consumePairingSession.mockReset().mockResolvedValue({ profileId: "profile-1" })
  deleteDeviceSyncSibling.mockReset().mockResolvedValue(undefined)
})

describe("PcDeviceSync", () => {
  it("shows a button to display the QR/code pairing panel, and an enter-code form -- never requests a camera", async () => {
    render(<PcDeviceSync />)

    expect(await screen.findByRole("button", { name: "Show QR Code" })).toBeInTheDocument()
    expect(screen.getByLabelText("Enter sync code")).toBeInTheDocument()
    // jsdom has no getUserMedia at all by default -- PcDeviceSync must never reference it (no scanner is ever mounted here).
    expect((navigator as { mediaDevices?: unknown }).mediaDevices).toBeUndefined()
  })

  it("clicking Show QR Code creates a pairing session and displays the QR and the human code", async () => {
    const user = userEvent.setup()
    render(<PcDeviceSync />)

    await user.click(await screen.findByRole("button", { name: "Show QR Code" }))

    expect(createPairingSession).toHaveBeenCalledWith(undefined)
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "QR" })).toBeInTheDocument()
  })

  it("entering a code redeems it as this device", async () => {
    const user = userEvent.setup()
    render(<PcDeviceSync />)

    await user.type(await screen.findByLabelText("Enter sync code"), "zzzz-yyyy")
    await user.click(screen.getByRole("button", { name: "Enter sync code" }))

    await waitFor(() => expect(consumePairingSession).toHaveBeenCalledWith({ code: "zzzz-yyyy" }, expect.any(String), "desktop"))
  })

  it("shows the connected devices list and lets the user revoke a device that is not this one", async () => {
    listDeviceSyncSiblings.mockResolvedValue({
      profileId: "profile-1",
      devices: [
        { profileId: "profile-1", deviceId: "device-pc-1", deviceLabel: "Desktop Chrome", deviceType: "desktop", createdAt: "t", lastSeenAt: "t" },
        { profileId: "profile-1", deviceId: "device-phone-1", deviceLabel: "Android PWA", deviceType: "android", createdAt: "t", lastSeenAt: "t" },
      ],
    })
    const user = userEvent.setup()
    render(<PcDeviceSync />)

    expect(await screen.findByText("Android PWA")).toBeInTheDocument()
    // This device's own row has no revoke button (never self-revoke from this list).
    const desktopRow = screen.getByText("Desktop Chrome").closest("li")!
    expect(desktopRow.querySelector(".device-sync-devices-revoke")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(deleteDeviceSyncSibling).toHaveBeenCalledWith("device-phone-1"))
  })

  it("shows an empty state when no devices are connected yet", async () => {
    render(<PcDeviceSync />)

    expect(await screen.findByText("No connected devices yet")).toBeInTheDocument()
  })
})
