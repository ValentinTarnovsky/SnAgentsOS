import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Standalone Vite build for the mobile web client. This is NOT electron-vite:
 * electron-vite only understands main/preload/renderer targets, so the phone
 * bundle gets its own plain Vite config emitted to out/mobile (packed into the
 * asar by the electron-builder `files: [out/**]` glob and served by the
 * embedded HTTP server via readFileSync).
 *
 * `base: './'` keeps every asset URL relative so the bundle works no matter
 * which LAN/Tailscale IP + port it is served from.
 */
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), tailwindcss()],
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
