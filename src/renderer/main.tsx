import React from 'react'
import ReactDOM from 'react-dom/client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/400-italic.css'
import '@fontsource/jetbrains-mono/500.css'
// Bold + bold-italic faces: terminals emit ANSI bold/italic constantly (AI CLIs,
// git, prompts). Without these the browser synthesizes a faux-bold/italic, which
// renders thick and unevenly hinted next to the real 400 glyphs - that is the
// "some letters thick, some thin" artifact.
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/jetbrains-mono/700-italic.css'

import './styles/globals.css'
import { App } from './App'
import { installGlobalErrorHandlers, reportRenderError, toReport } from './lib/renderErrors'
import { installDevHooks } from './lib/devHooks'
import { isSnBoundary } from './components/common/ErrorBoundary'

// Async errors (pty.onData, term.write) never reach a boundary (E4-FR-23).
installGlobalErrorHandlers()
const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
if (isDev) installDevHooks()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement, {
  // React 19 unmounts the root on an uncaught render error; the ptys survive
  // it (E4-FR-36), and main gets the report.
  onUncaughtError: (error, info) => {
    reportRenderError(toReport('root', error, { componentStack: info.componentStack }))
    console.error(error)
  },
  // Our boundaries report on their own; anything else caught still goes to main.
  onCaughtError: (error, info) => {
    if (!isSnBoundary(info.errorBoundary)) reportRenderError(toReport('root', error, { componentStack: info.componentStack }))
    if (isDev) console.error(error)
  },
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
