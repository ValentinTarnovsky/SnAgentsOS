import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    // Fault injection of the legacy migration (SNAOS_TEST_FAULT) exists only in a
    // test build made with SNAOS_TEST_FAULTS_BUILD=1; a release always has false.
    define: { __SNAOS_TEST_FAULTS__: JSON.stringify(process.env.SNAOS_TEST_FAULTS_BUILD === '1') },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), statusRuntime: resolve(__dirname, 'src/main/status/statusRuntime.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
})
