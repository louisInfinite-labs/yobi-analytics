import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceSyncSettings } from "./DeviceSyncSettings"
import * as platformDetection from "../platformDetection"
import * as deviceSyncApi from "../api/deviceSyncApi"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../platformDetection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platformDetection")>()),
  useDeviceSyncPlatform: vi.fn(),
}))
vi.mock("../api/deviceSyncApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/deviceSyncApi")>()),
  getThisDeviceId: vi.fn(() => "device-1"),
  listDeviceSyncSiblings: vi.fn().mockResolvedValue({ profileId: null, devices: [] }),
}))

const useDeviceSyncPlatform = vi.mocked(platformDetection.useDeviceSyncPlatform)

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  vi.mocked(deviceSyncApi.listDeviceSyncSiblings).mockClear()
})

describe("DeviceSyncSettings platform branching", () => {
  it("renders the full PC page for pc", async () => {
    useDeviceSyncPlatform.mockReturnValue("pc")
    render(<DeviceSyncSettings />)
    expect(await screen.findByRole("button", { name: "Show QR Code" })).toBeInTheDocument()
  })

  it("renders the mobile page (never a QR-display button) for android-pwa", async () => {
    useDeviceSyncPlatform.mockReturnValue("android-pwa")
    render(<DeviceSyncSettings />)
    expect(await screen.findByRole("button", { name: "Scan QR Code" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Show QR Code" })).not.toBeInTheDocument()
  })

  it("renders the mobile page for ios-pwa", async () => {
    useDeviceSyncPlatform.mockReturnValue("ios-pwa")
    render(<DeviceSyncSettings />)
    expect(await screen.findByRole("button", { name: "Scan QR Code" })).toBeInTheDocument()
  })

  it("renders Android install guidance (no pairing API call) for android-browser", () => {
    useDeviceSyncPlatform.mockReturnValue("android-browser")
    render(<DeviceSyncSettings />)
    expect(screen.getByText(/install OshiYobi first/i)).toBeInTheDocument()
    expect(deviceSyncApi.listDeviceSyncSiblings).not.toHaveBeenCalled()
  })

  it("renders iOS Safari guidance (no pairing API call) for ios-safari", () => {
    useDeviceSyncPlatform.mockReturnValue("ios-safari")
    render(<DeviceSyncSettings />)
    expect(screen.getByText(/add OshiYobi to your Home Screen first/i)).toBeInTheDocument()
    expect(deviceSyncApi.listDeviceSyncSiblings).not.toHaveBeenCalled()
  })
})
