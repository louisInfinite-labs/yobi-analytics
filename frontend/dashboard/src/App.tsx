import { AdminPanel } from "./components/AdminPanel"
import { DashboardPage } from "./components/DashboardPage"
import { HomePage } from "./components/home/HomePage"
import { LiveScheduleDock } from "./components/LiveScheduleDock"
import { MemberThemeProvider } from "./theme/MemberThemeProvider"

/** Reachable only via `?admin` on the Dashboard's own URL — see AdminPanel's
 * own docstring for why this isn't a normal, linked route. */
function isAdminRoute(): boolean {
  return new URLSearchParams(window.location.search).has("admin")
}

/** Home V1 (local_tasks/VTUBER_HOME_V1_IMPLEMENTATION_SPEC.md) is reachable
 * via `?home`, the same lightweight query-param convention as `?admin` —
 * there is no router/sidebar shell yet for it to live behind (see this
 * session's own scoping discussion), so this stays a flat toggle rather
 * than a real route until that shell exists. */
function isHomeRoute(): boolean {
  return new URLSearchParams(window.location.search).has("home")
}

/** Root component: wraps the dashboard (or the admin/home screen) in the
 * member/theme context provider. The Live Schedule Dock is mounted here,
 * above whichever page is showing, so it stays available on every one of
 * them (spec: "it must be available outside Home") rather than living
 * inside HomePage alone. */
function App() {
  const page = isAdminRoute() ? <AdminPanel /> : isHomeRoute() ? <HomePage /> : <DashboardPage />
  return (
    <MemberThemeProvider>
      {page}
      <LiveScheduleDock />
    </MemberThemeProvider>
  )
}

export default App
