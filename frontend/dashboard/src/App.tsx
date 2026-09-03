import { DashboardPage } from "./components/DashboardPage"
import { MemberThemeProvider } from "./theme/MemberThemeProvider"

function App() {
  return (
    <MemberThemeProvider>
      <DashboardPage />
    </MemberThemeProvider>
  )
}

export default App
