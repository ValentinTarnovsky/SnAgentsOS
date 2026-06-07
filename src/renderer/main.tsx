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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
