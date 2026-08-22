import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyPreferences, loadPreferences } from './preferences'
import type { PortalClient } from './types'
import '../../../src/shared/sciforge-design-tokens.css'
import './styles/tokens.css'
import './styles/app.css'

applyPreferences(loadPreferences())

const root = document.getElementById('root')
if (!root) throw new Error('SciForge Portal root is missing.')
let demoClient: PortalClient | undefined
if (import.meta.env.DEV && new URLSearchParams(globalThis.location.search).get('demo') === '1') {
  demoClient = (await import('./demo')).createDemoClient()
}
createRoot(root).render(<StrictMode><App client={demoClient} /></StrictMode>)
