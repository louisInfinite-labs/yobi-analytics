import { AdminPanel } from "../pages/admin/AdminPanel"
import { DashboardPage } from "../pages/dashboard/DashboardPage"
import { HomePage } from "../pages/home/HomePage"
import { LiveScheduleDock } from "../features/live-status/components/LiveScheduleDock"
import { MainNavbar } from "./navigation/MainNavbar"
import { SettingsPage } from "../pages/settings/SettingsPage"
import { useCurrentPage } from "./navigation/useCurrentPage"
import { MemberThemeProvider } from "../shared/theme/MemberThemeProvider"

/** Reachable only via `?admin` on the Dashboard's own URL — see AdminPanel's
 * own docstring for why this isn't a normal, linked route. Deliberately not
 * one of MainNavbar's links, so it stays out of the way of the normal nav. */
function isAdminRoute(): boolean {
  return new URLSearchParams(window.location.search).has("admin")
}

/** Root component: wraps the dashboard/home screen (or the admin screen) in
 * the member/theme context provider, alongside the fixed MainNavbar every
 * other page docks against (see main-navbar.css's .app-shell). The Live
 * Schedule Dock is mounted here, above whichever page is showing, so it
 * stays available on every one of them (spec: "it must be available
 * outside Home") rather than living inside HomePage alone. Admin stays
 * outside .app-shell -- it's an unlinked, full-page debug tool, not part
 * of the normal MainNavbar-driven nav. */
function App() {
  const [page] = useCurrentPage()
  if (isAdminRoute()) {
    return (
      <MemberThemeProvider>
        <AdminPanel />
      </MemberThemeProvider>
    )
  }
  return (
    <MemberThemeProvider>
      <div className="app-shell">
        <MainNavbar />
        <div className="app-shell__content">
          {page === "home" ? <HomePage /> : page === "settings" ? <SettingsPage /> : <DashboardPage />}
        </div>
      </div>
      <LiveScheduleDock />
    </MemberThemeProvider>
  )
}

export default App
