import { DashboardPage } from "./components/DashboardPage"
import { MemberThemeProvider } from "./theme/MemberThemeProvider"

/** Root component: wraps the dashboard in the member/theme context provider. */
function App() {
  return (
    <MemberThemeProvider>
      <DashboardPage />
    </MemberThemeProvider>
  )
}

export default App
