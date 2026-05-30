import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { snXtermTheme } from '@/lib/xterm-theme'

export interface UseXtermOptions {
  /** Stable pane id (ties this terminal to a workspace pane). */
  paneId: string
  cwd?: string
  shell?: string
  /** Command line typed into the shell after spawn (e.g. an AI CLI). */
  initialCommand?: string
  fontSize?: number
}

/**
 * Mounts an xterm Terminal into `containerRef`, spawns a backing pty, and wires
 * the bidirectional data + resize streams. Disposes everything (incl. the pty)
 * on unmount.
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  opts: UseXtermOptions,
): void {
  const ptyIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Guard against re-entry without a cleanup (not against StrictMode remount,
    // which legitimately tears down and re-runs the effect).
    if (startedRef.current) return
    startedRef.current = true

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      fontSize: opts.fontSize ?? 13,
      theme: snXtermTheme,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
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
      term.dispose()
      startedRef.current = false
    }
  }, [containerRef, opts.paneId, opts.cwd, opts.shell, opts.initialCommand, opts.fontSize])
}
