import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')
// The snaos CLI prints the guide of the installed version (E8-FR-21).
const appVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    // Fault injection of the legacy migration (SNAOS_TEST_FAULT) exists only in a
    // test build made with SNAOS_TEST_FAULTS_BUILD=1; a release always has false.
    define: { __SNAOS_TEST_FAULTS__: JSON.stringify(process.env.SNAOS_TEST_FAULTS_BUILD === '1'), __SNAOS_APP_VERSION__: JSON.stringify(appVersion) },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          statusRuntime: resolve(__dirname, 'src/main/status/statusRuntime.ts'),
          // `snaos` binary (E8-FR-13), run by the shim with ELECTRON_RUN_AS_NODE: Node core only.
          cli: resolve(__dirname, 'src/main/cli/cliEntry.ts'),
        },
      },
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
