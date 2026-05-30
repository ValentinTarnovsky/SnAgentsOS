import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '@/lib/store'
import { buildXtermTheme } from '@/themes'

/** GPU renderer with a 2D-canvas fallback (WebGL contexts are capped per page). */
function loadRenderer(term: Terminal): void {
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    try {
      term.loadAddon(new CanvasAddon())
    } catch {
      /* fall back to the default DOM renderer */
    }
  }
}

export interface UseXtermOptions {
  /** Stable pane id (ties this terminal to a workspace pane). */
  paneId: string
  cwd?: string
  shell?: string
  /** Command line typed into the shell after spawn (e.g. an AI CLI). */
  initialCommand?: string
  fontSize?: number
  /**
   * Whether this terminal's workspace is currently visible. Hidden terminals
   * (display:none) can't be measured by xterm, so we refit when they reveal.
   */
  isActive?: boolean
}

/**
 * Mounts an xterm Terminal into `containerRef`, spawns a backing pty, and wires
 * the bidirectional data + resize streams. The pty is killed only on real
 * teardown (pane/workspace removal) — NOT on theme/font/visibility changes —
 * so running sessions survive workspace switches.
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  opts: UseXtermOptions,
): void {
  const ptyIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const theme = useAppStore((s) => s.settings.theme)
  const customColors = useAppStore((s) => s.settings.customColors)
  const fontSize = useAppStore((s) => s.settings.fontSize)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Guard against re-entry without a cleanup (not against StrictMode remount,
    // which legitimately tears down and re-runs the effect).
    if (startedRef.current) return
    startedRef.current = true

    const settings = useAppStore.getState().settings
    const term = new Terminal({
      fontFamily: settings.fontFamily || "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      fontSize: opts.fontSize ?? settings.fontSize ?? 13,
      theme: buildXtermTheme(settings.theme, settings.customColors),
      cursorBlink: true,
      scrollback: settings.scrollback ?? 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    termRef.current = term
    fitRef.current = fit
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    loadRenderer(term)
    fit.fit()

    let disposed = false
    let offData: () => void = () => undefined
    let offExit: () => void = () => undefined

    window.snApi.pty
      .spawn({
        paneId: opts.paneId,
        shell: opts.shell,
        cwd: opts.cwd,
        initialCommand: opts.initialCommand,
        cols: term.cols,
        rows: term.rows,
      })
      .then(({ ptyId }) => {
        if (disposed) {
          void window.snApi.pty.kill(ptyId)
          return
        }
        ptyIdRef.current = ptyId
        offData = window.snApi.pty.onData((e) => {
          if (e.ptyId === ptyId) term.write(e.data)
        })
        offExit = window.snApi.pty.onExit((e) => {
          if (e.ptyId === ptyId) {
            term.write(`\r\n\x1b[2m[process exited (${e.exitCode})]\x1b[0m\r\n`)
          }
        })
      })
      .catch((err) => term.write(`\r\n\x1b[31mFailed to start shell: ${String(err)}\x1b[0m\r\n`))

    const input = term.onData((data) => {
      const id = ptyIdRef.current
      if (id) window.snApi.pty.write({ ptyId: id, data })
    })

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* container not measurable yet */
      }
      const id = ptyIdRef.current
      if (id) window.snApi.pty.resize({ ptyId: id, cols: term.cols, rows: term.rows })
    })
    resizeObserver.observe(container)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      input.dispose()
      offData()
      offExit()
      const id = ptyIdRef.current
      if (id) void window.snApi.pty.kill(id)
      ptyIdRef.current = null
      termRef.current = null
      fitRef.current = null
      term.dispose()
      startedRef.current = false
    }
    // Spawn ONCE per pane. cwd/shell/initialCommand are captured at mount, so
    // editing a preset's command only affects NEW consoles and never restarts
    // already-running ones. Theme/font/visibility update via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, opts.paneId])

  // Live theme updates — swap the palette in place.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = buildXtermTheme(theme, customColors)
  }, [theme, customColors])

  // Live font-size updates — resize without remounting.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term) return
    term.options.fontSize = fontSize
    try {
      fit?.fit()
    } catch {
      /* not measurable */
    }
    const id = ptyIdRef.current
    if (id) window.snApi.pty.resize({ ptyId: id, cols: term.cols, rows: term.rows })
  }, [fontSize])

  // Refit when this terminal becomes visible (hidden xterms can't measure).
  useEffect(() => {
    if (!opts.isActive) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* not measurable yet */
      }
      const id = ptyIdRef.current
      if (id) window.snApi.pty.resize({ ptyId: id, cols: term.cols, rows: term.rows })
    })
    return () => cancelAnimationFrame(raf)
  }, [opts.isActive])
}
