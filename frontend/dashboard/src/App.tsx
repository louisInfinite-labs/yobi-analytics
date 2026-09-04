import { AdminPanel } from "./components/AdminPanel"
import { DashboardPage } from "./components/DashboardPage"
import { MemberThemeProvider } from "./theme/MemberThemeProvider"

/** Reachable only via `?admin` on the Dashboard's own URL — see AdminPanel's
 * own docstring for why this isn't a normal, linked route. */
function isAdminRoute(): boolean {
  return new URLSearchParams(window.location.search).has("admin")
}

/** Root component: wraps the dashboard (or the admin screen) in the member/theme context provider. */
function App() {
  return <MemberThemeProvider>{isAdminRoute() ? <AdminPanel /> : <DashboardPage />}</MemberThemeProvider>
}

export default App
