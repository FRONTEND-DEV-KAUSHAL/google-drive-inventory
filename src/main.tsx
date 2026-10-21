import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { initAuth } from './auth.ts'
import { Overlays } from './ui.tsx'
import '@fontsource-variable/inter'
import './theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Overlays />
  </StrictMode>,
)
initAuth().catch(console.error)
