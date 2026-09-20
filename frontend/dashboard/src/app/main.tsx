import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import '../features/dashboard/styles/dashboard.css'
import '../pages/home/styles/home.css'
import './navigation/styles/main-navbar.css'
import '../pages/settings/styles/settings.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
