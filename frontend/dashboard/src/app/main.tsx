import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import '../shared/styles/segmentedFilter.css'
import '../shared/styles/creatorAvatar.css'
import '../features/dashboard/styles/dashboard.css'
import '../pages/home/styles/home.css'
import './navigation/styles/main-navbar.css'
import '../pages/settings/styles/settings.css'
import '../pages/about/styles/about.css'
import App from './App.tsx'
import { startServiceWorker } from '../features/pwa/registerServiceWorker'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The one service worker (PWA install + Web Push) starts with the app, independent of notification permission.
startServiceWorker()
