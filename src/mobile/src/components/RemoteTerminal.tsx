/**
 * The live mirrored terminal. Mounts an xterm Terminal with options mirroring
 * the desktop (JetBrains Mono, weights 400/700, Canvas renderer for the same
 * anti-mojibake reason the desktop defaults to it), and drives it entirely from
 * the server's replay/out/exit frames.
 *
 * The phone never resizes the pty: term.resize(cols, rows) adopts the geometry
 * carried by each replay frame, and the fit solver picks a font size so those
 * fixed columns fit the viewport width (with horizontal pan as the fallback
 * when even the minimum size overflows). Input (typing + KeyBar) is forwarded
 * to the pty via the WS client; the Ctrl latch turns the next printable char
 * into its control code.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { client, type TermFrame } from '../lib/client'
import { useRemoteStore } from '../lib/store'
import { resetRatio, solveFont } from '../lib/fit'
import { setActiveTerm } from '../lib/terminalBus'

export function RemoteTerminal(): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const colsRef = useRef(80)
  const xtermTheme = useRemoteStore((s) => s.xtermTheme)
  const fontOverride = useRemoteStore((s) => s.fontOverride)
  const subscribedPaneId = useRemoteStore((s) => s.subscribedPaneId)

  // Mount the terminal once. Frames, resize handling and input wiring all live
  // inside this effect; React state only drives theme/font/pane-switch effects.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const hostPlatform = useRemoteStore.getState().hostPlatform

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 14,
      fontWeight: 400,
      fontWeightBold: 700,
      theme: useRemoteStore.getState().xtermTheme ?? undefined,
      cursorBlink: false,
      scrollback: 5000,
      allowProposedApi: true,
      // ConPTY line-wrap heuristic only makes sense when the desktop is Windows.
      ...(hostPlatform === 'win32' ? { windowsPty: { backend: 'conpty' as const } } : {}),
    })
    termRef.current = term

    let canvas: CanvasAddon | null = null
    try {
      canvas = new CanvasAddon()
      term.loadAddon(canvas)
    } catch {
      /* fall back to xterm's DOM renderer if canvas construction fails */
    }
    term.open(container)
    setActiveTerm(term)

    const applyFont = (): void => {
      const width = container.clientWidth || window.innerWidth
      const { fontSize } = solveFont(colsRef.current, width, useRemoteStore.getState().fontOverride)
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
    }

    // Typed input -> pty. The Ctrl latch converts the next printable char to its
    // control code (charCode & 0x1f) then releases.
    const inputSub = term.onData((data) => {
      let out = data
      const st = useRemoteStore.getState()
      if (st.ctrlLatch) {
        if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
          out = String.fromCharCode(data.charCodeAt(0) & 0x1f)
        }
        st.setCtrlLatch(false)
      }
      client.sendInput(out)
    })

    // Server frames. Every replay resets the terminal then writes the fresh
    // history snapshot, adopting the pty's real cols/rows.
    client.setTermListener((f: TermFrame) => {
      if (f.type === 'replay') {
        colsRef.current = f.cols
        applyFont()
        try {
          term.resize(Math.max(1, f.cols), Math.max(1, f.rows))
          term.reset()
          term.write(f.data)
        } catch {
          /* terminal torn down between frame and handler */
        }
      } else if (f.type === 'out') {
        term.write(f.data)
      } else if (f.type === 'exit') {
        term.write(`\r\n\x1b[2m[process exited (${f.exitCode})]\x1b[0m\r\n`)
      }
    })

    // Cold start: the first mount may precede the JetBrains Mono web font. Once
    // it is ready, re-measure the advance ratio, drop the stale glyph atlas and
    // repaint so metrics/weights are correct (mirrors the desktop useXterm).
    let disposed = false
    void document.fonts.ready.then(() => {
      if (disposed) return
      resetRatio()
      applyFont()
      try {
        term.clearTextureAtlas()
        term.refresh(0, term.rows - 1)
      } catch {
        /* torn down */
      }
    })

    const onResize = (): void => applyFont()
    const vv = window.visualViewport
    vv?.addEventListener('resize', onResize)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)

    return () => {
      disposed = true
      client.setTermListener(null)
      setActiveTerm(null)
      vv?.removeEventListener('resize', onResize)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      inputSub.dispose()
      try {
        canvas?.dispose()
      } catch {
        /* ignore */
      }
      term.dispose()
      termRef.current = null
    }
    // Mount once; theme/font/pane changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live theme swap.
  useEffect(() => {
    const term = termRef.current
    if (term && xtermTheme) term.options.theme = xtermTheme
  }, [xtermTheme])

  // Manual font-size override (settings sheet +/-).
  useEffect(() => {
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return
    const width = container.clientWidth || window.innerWidth
    const { fontSize } = solveFont(colsRef.current, width, fontOverride)
    term.options.fontSize = fontSize
  }, [fontOverride])

  // Switching panes: clear the stale content immediately so the gap before the
  // new pane's replay lands is blank, not the previous console's output.
  useEffect(() => {
    const term = termRef.current
    if (term && subscribedPaneId) {
      try {
        term.reset()
      } catch {
        /* ignore */
      }
    }
  }, [subscribedPaneId])

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: 'var(--color-bg-primary)' }}>
      <div
        ref={containerRef}
        data-scrollable
        className="h-full w-full overflow-x-auto overflow-y-hidden"
      />
    </div>
  )
}
