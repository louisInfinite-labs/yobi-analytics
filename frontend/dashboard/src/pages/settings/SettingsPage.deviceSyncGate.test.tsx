import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

// 裝置同步 (Device Sync) is development-only for now: backend/infra rollout isn't approved. In development it keeps its
// Settings nav entry and `?section=deviceSync` renders it; in a production build there is no nav entry, the section param
// falls back to the default section, and the Device Sync module is never imported/mounted (no controller, no API calls,
// no camera/scanner init). `import.meta.env.DEV` is the gate -- the same mechanism App.dashboardGate.test.tsx exercises
// for the Video Data page -- so these tests flip it with vi.stubEnv and load the modules fresh each time (SettingsPage
// reads it once at module load, same as App.tsx does for DashboardPage).
//
// The sibling section components and MemberThemeProvider are mocked out (same as App.dashboardGate.test.tsx mocks the
// other top-level pages): vi.resetModules() gives the freshly re-imported SettingsPage its own ThemeContext module
// instance, so the real MemberThemeProvider from a normal top-of-file import would no longer match it.

vi.mock("../../shared/theme/MemberThemeProvider", () => ({ MemberThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("../../features/oshi/components/MyOshiSettings", () => ({ MyOshiSettings: () => <div data-testid="my-oshi-settings" /> }))
vi.mock("../../features/oshi/components/OshiSettings", () => ({ OshiSettings: () => <div data-testid="oshi-settings" /> }))
vi.mock("../../features/notifications/components/NotificationSettings", () => ({ NotificationSettings: () => <div data-testid="notification-settings" /> }))
vi.mock("./DisplaySettings", () => ({ DisplaySettings: () => <div data-testid="display-settings" /> }))

const deviceSyncSettingsMock = vi.fn(() => <div data-testid="device-sync-settings" />)
vi.mock("../../features/device-sync/components/DeviceSyncSettings", () => ({
  DeviceSyncSettings: () => deviceSyncSettingsMock(),
}))

const DEVICE_SYNC_LABEL = "Device Sync"

async function loadSettingsPage(isDev: boolean) {
  vi.resetModules()
  vi.stubEnv("DEV", isDev)
  localStorage.setItem("yobi.locale", "en")
  return (await import("./SettingsPage")).SettingsPage
}

function renderSettingsPage(SettingsPage: React.ComponentType) {
  return render(<SettingsPage />)
}

beforeEach(() => {
  window.history.pushState({}, "", "/setting")
  resetAllSharedStateForTests()
  deviceSyncSettingsMock.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("裝置同步 in development", () => {
  it("has its Settings nav entry, and selecting it mounts Device Sync", async () => {
    const SettingsPage = await loadSettingsPage(true)
    renderSettingsPage(SettingsPage)
    const user = userEvent.setup()

    const button = screen.getByRole("button", { name: DEVICE_SYNC_LABEL })
    await user.click(button)

    expect(button).toHaveAttribute("aria-current", "page")
    expect(await screen.findByTestId("device-sync-settings")).toBeInTheDocument()
    expect(deviceSyncSettingsMock).toHaveBeenCalled()
  })

  it("a direct ?section=deviceSync URL renders Device Sync", async () => {
    window.history.pushState({}, "", "/setting?section=deviceSync")
    const SettingsPage = await loadSettingsPage(true)
    renderSettingsPage(SettingsPage)

    expect(await screen.findByTestId("device-sync-settings")).toBeInTheDocument()
  })
})

describe("裝置同步 in production", () => {
  it("renders no nav entry for it (not hidden by CSS: the button is not in the DOM), and the other four stay", async () => {
    const SettingsPage = await loadSettingsPage(false)
    renderSettingsPage(SettingsPage)

    expect(screen.queryByRole("button", { name: DEVICE_SYNC_LABEL })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(DEVICE_SYNC_LABEL)
    expect(Array.from(document.querySelectorAll(".settings-secondary-navbar__link")).map((item) => item.textContent)).toEqual([
      "Oshi Settings",
      "Favorites List",
      "Live/Video Notifications",
      "Display",
    ])
  })

  it("a direct ?section=deviceSync URL falls back to the default section instead of rendering it, and Device Sync is never mounted", async () => {
    window.history.pushState({}, "", "/setting?section=deviceSync")
    const SettingsPage = await loadSettingsPage(false)
    renderSettingsPage(SettingsPage)

    expect(await screen.findByRole("button", { name: "Favorites List" })).toHaveAttribute("aria-current", "page")
    expect(screen.queryByTestId("device-sync-settings")).not.toBeInTheDocument()
    expect(deviceSyncSettingsMock).not.toHaveBeenCalled()
  })
})
