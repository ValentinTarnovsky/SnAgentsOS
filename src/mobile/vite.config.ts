import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const APP_VERSION = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version as string

/**
 * Standalone Vite build for the mobile web client. This is NOT electron-vite:
 * electron-vite only understands main/preload/renderer targets, so the phone
 * bundle gets its own plain Vite config emitted to out/mobile (packed into the
 * asar by the electron-builder `files: [out/**]` glob and served by the
 * embedded HTTP server via readFileSync).
 *
 * `base: './'` keeps every asset URL relative so the bundle works no matter
 * which LAN/Tailscale IP + port it is served from.
 *
 * `__APP_VERSION__` bakes the desktop version (root package.json; the mobile
 * package.json has none) into the bundle so the client can tell a cached old
 * bundle from the desktop it talks to (authOk.appVersion, E1-FR-15).
 */
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, '../../out/mobile'),
    emptyOutDir: true,
    target: 'es2020',
  },
})
