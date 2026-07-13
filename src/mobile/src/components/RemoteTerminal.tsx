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
import { getStoredHostPlatform } from '../lib/auth'

export function RemoteTerminal(): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const colsRef = useRef(80)
  /** True when even MIN_FONT overflows the viewport (solveFont's overflow flag). */
  const overflowRef = useRef(false)
  /** Set once by the mount effect; lets the fontOverride effect below re-run
   * the same cursor-follow pan logic without duplicating it out of scope. */
  const followCursorRef = useRef<() => void>(() => {})
  const xtermTheme = useRemoteStore((s) => s.xtermTheme)
  const fontOverride = useRemoteStore((s) => s.fontOverride)
  const subscribedPaneId = useRemoteStore((s) => s.subscribedPaneId)

  // Mount the terminal once. Frames, resize handling and input wiring all live
  // inside this effect; React state only drives theme/font/pane-switch effects.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // On the pairing path the store's hostPlatform is unknown; fall back to the
    // value cached from a previous session's authOk so windowsPty still applies.
    const hostPlatform = useRemoteStore.getState().hostPlatform || getStoredHostPlatform()

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

    // Best-effort hygiene on xterm's hidden input (item 5: iOS's input accessory
    // bar - the prev/next chevrons + close-keyboard button above the keyboard -
    // is OS chrome over any focused text field; no web API removes it. This does
    // NOT remove the bar, it only avoids opting into extra affordances on it.
    const helperTextarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (helperTextarea) {
      helperTextarea.setAttribute('autocorrect', 'off')
      helperTextarea.setAttribute('autocapitalize', 'off')
      helperTextarea.setAttribute('spellcheck', 'false')
    }

    const applyFont = (): void => {
      const width = container.clientWidth || window.innerWidth
      const { fontSize, overflow } = solveFont(colsRef.current, width, useRemoteStore.getState().fontOverride)
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
      overflowRef.current = overflow
      // Re-sync the pan immediately on any transition (not just overflow->fit):
      // a resize/rotation can also flip fit->overflow with the caret already
      // outside the new, narrower width.
      followCursorRef.current()
    }

    // Cursor-follow: when the grid overflows the viewport on either axis, pan the
    // container so the caret stays visible with a small margin (hysteresis)
    // instead of the browser's incidental focus-scroll. Never resizes the pty
    // (v1 intact) - the two axes are independent:
    //  - X: the width-overflow flag from solveFont (grid wider than the viewport).
    //  - Y: the fixed grid is taller than the keyboard-shrunk container, so the
    //    TUI's bottom input line would otherwise be clipped behind the keyboard.
    const HYSTERESIS_CELLS = 2
    let cursorRaf: number | null = null
    const followCursor = (): void => {
      cursorRaf = null
      // Horizontal pan (only when the grid overflows the viewport width).
      if (overflowRef.current) {
        const cols = term.cols || 1
        const cellW = container.scrollWidth / cols
        const caretX = term.buffer.active.cursorX * cellW
        const margin = HYSTERESIS_CELLS * cellW
        const viewLeft = container.scrollLeft
        const viewRight = viewLeft + container.clientWidth
        if (caretX < viewLeft + margin) {
          container.scrollLeft = Math.max(0, caretX - margin)
        } else if (caretX > viewRight - margin) {
          container.scrollLeft = caretX - container.clientWidth + margin
        }
      } else if (container.scrollLeft !== 0) {
        container.scrollLeft = 0
      }
      // Vertical pan (only when the grid is taller than the container). Keeps
      // the caret row on screen so the input line docks above the soft keyboard.
      if (container.scrollHeight > container.clientHeight + 1) {
        const rows = term.rows || 1
        const cellH = container.scrollHeight / rows
        const caretY = term.buffer.active.cursorY * cellH
        const marginY = HYSTERESIS_CELLS * cellH
        const viewTop = container.scrollTop
        const viewBottom = viewTop + container.clientHeight
        if (caretY < viewTop + marginY) {
          container.scrollTop = Math.max(0, caretY - marginY)
        } else if (caretY + cellH > viewBottom - marginY) {
          container.scrollTop = caretY + cellH - container.clientHeight + marginY
        }
      } else if (container.scrollTop !== 0) {
        container.scrollTop = 0
      }
    }
    const scheduleCursorFollow = (): void => {
      if (cursorRaf != null) return
      cursorRaf = requestAnimationFrame(followCursor)
    }
    followCursorRef.current = followCursor
    const cursorSub = term.onCursorMove(() => scheduleCursorFollow())

    // While iOS slides the soft keyboard in/out, visualViewport.resize fires
    // late, so re-pan to the caret every frame for a short window on focus
    // change (mirrors the --vvh settle loop in viewport.ts). This closes the
    // "typing blind" gap where the input line is still clipped behind the
    // keyboard until the first keystroke nudges it into view.
    let settleRaf: number | null = null
    const startSettle = (durationMs: number): void => {
      if (settleRaf != null) cancelAnimationFrame(settleRaf)
      const deadline = performance.now() + durationMs
      const tick = (now: number): void => {
        followCursor()
        settleRaf = now < deadline ? requestAnimationFrame(tick) : null
      }
      settleRaf = requestAnimationFrame(tick)
    }
    const onFocusIn = (): void => startSettle(500)
    const onFocusOut = (): void => startSettle(300)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)

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
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      if (cursorRaf != null) cancelAnimationFrame(cursorRaf)
      if (settleRaf != null) cancelAnimationFrame(settleRaf)
      cursorSub.dispose()
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

  // Manual font-size override (settings sheet +/-). Must sync overflowRef too:
  // solveFont's overflow flag is what the cursor-follow effect above reads, and
  // this is the only other place fontSize (hence overflow) can change.
  useEffect(() => {
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return
    const width = container.clientWidth || window.innerWidth
    const { fontSize, overflow } = solveFont(colsRef.current, width, fontOverride)
    term.options.fontSize = fontSize
    overflowRef.current = overflow
    followCursorRef.current()
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
