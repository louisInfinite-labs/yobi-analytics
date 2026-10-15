import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The Video Data page (影片數據) is development-only. In development it keeps its nav entry and its /dashboard route; in a production
// build there is no nav entry, the URL is not a page, and the page is never rendered. `import.meta.env.DEV` is the gate (the project's own
// dev-only mechanism), so these tests flip it with vi.stubEnv and load the modules fresh each time (App reads it at module load).

vi.mock("../pages/home/HomePage", () => ({ HomePage: () => <div data-testid="home-page" /> }))
vi.mock("../pages/settings/SettingsPage", () => ({ SettingsPage: () => <div data-testid="settings-page" /> }))
vi.mock("../pages/schedule/LiveSchedulePage", () => ({ LiveSchedulePage: () => <div data-testid="schedule-page" /> }))
vi.mock("../pages/about/AboutPage", () => ({ AboutPage: () => <div data-testid="about-page" /> }))
vi.mock("../pages/admin/AdminPanel", () => ({ AdminPanel: () => <div data-testid="admin-page" /> }))
vi.mock("../pages/dashboard/DashboardPage", () => ({ DashboardPage: () => <div data-testid="dashboard-page" /> }))
vi.mock("../features/live-status/components/LiveScheduleDock", () => ({ LiveScheduleDock: () => null }))
vi.mock("../features/notifications/hooks/useNotificationLocaleSync", () => ({ useNotificationLocaleSync: () => {} }))
vi.mock("../features/notifications/hooks/useRetiredTopicResync", () => ({ useRetiredTopicResync: () => {} }))
vi.mock("../shared/theme/MemberThemeProvider", () => ({ MemberThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

// Every test re-imports the whole App after vi.resetModules(); the app shell now carries the phone header search (antd's Input), so that
// fresh import takes a few seconds on a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const VIDEO_DATA_LABEL = "Video Data"

async function loadApp(isDev: boolean) {
  vi.resetModules()
  vi.stubEnv("DEV", isDev)
  localStorage.setItem("yobi.locale", "en")
  return (await import("./App")).default
}

beforeEach(() => {
  window.history.pushState({}, "", "/")
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe("影片數據 in development", () => {
  it("has its nav entry, and /dashboard renders the page", async () => {
    window.history.pushState({}, "", "/dashboard")
    const App = await loadApp(true)

    render(<App />)

    expect(screen.getByRole("button", { name: VIDEO_DATA_LABEL })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("dashboard-page")).toBeInTheDocument())
    expect(screen.queryByTestId("home-page")).not.toBeInTheDocument()
  })

  it("useCurrentPage resolves /dashboard to the dashboard page", async () => {
    window.history.pushState({}, "", "/dashboard")
    vi.resetModules()
    vi.stubEnv("DEV", true)
    const { useCurrentPage } = await import("./navigation/useCurrentPage")

    const { result } = renderHook(() => useCurrentPage())

    expect(result.current[0]).toBe("dashboard")
  })
})

describe("影片數據 in production", () => {
  it("renders NO nav entry for it (not hidden by CSS: the button is not in the DOM), and the other four stay", async () => {
    const App = await loadApp(false)

    render(<App />)

    expect(screen.queryByRole("button", { name: VIDEO_DATA_LABEL })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(VIDEO_DATA_LABEL)
    // The navigation entries only (the phone hamburger and the drawer's close button are buttons too, but not entries).
    expect(Array.from(document.querySelectorAll(".main-navbar__link")).map((button) => button.getAttribute("aria-label"))).toEqual(["Home", "Schedule", "Settings", "About"])
  })

  it("typing /dashboard does not load the page: it behaves like any unknown path (Home) and nothing of the page is rendered", async () => {
    window.history.pushState({}, "", "/dashboard")
    const App = await loadApp(false)

    render(<App />)
    await act(async () => {})

    expect(screen.getByTestId("home-page")).toBeInTheDocument()
    expect(screen.queryByTestId("dashboard-page")).not.toBeInTheDocument()
    expect(document.querySelector(".dashboard-page")).toBeNull()
    expect(screen.queryByRole("button", { name: VIDEO_DATA_LABEL })).not.toBeInTheDocument()
  })

  it("useCurrentPage never returns the dashboard page for /dashboard", async () => {
    window.history.pushState({}, "", "/dashboard")
    vi.resetModules()
    vi.stubEnv("DEV", false)
    const { useCurrentPage } = await import("./navigation/useCurrentPage")

    const { result } = renderHook(() => useCurrentPage())

    expect(result.current[0]).toBe("home")
  })
})
