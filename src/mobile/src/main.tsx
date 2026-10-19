/**
 * Phone client entry. Fonts are imported so the woff2 files ship inside the
 * bundle (no external requests - required under the server's strict CSP and on
 * an offline LAN). Viewport guards and the WS client boot before React mounts.
 */
import { createRoot } from 'react-dom/client'
import './index.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import { App } from './App'
import { initViewport } from './lib/viewport'
import { client } from './lib/client'
import { registerServiceWorker } from './lib/serviceWorker'
import { startWakeLock } from './lib/wakeLock'
import { startCacheTimer } from './lib/cacheTimer'

initViewport()
client.start()
// E3-FR-47 / FR-49: both only act in a secure context.
registerServiceWorker()
startWakeLock()
// Claude cache countdown (E5-FR-28): follows every paneStatus from the first frame.
startCacheTimer()

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
