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
 *
 * Composer mode (E1-FR-29): the helper textarea turns readOnly with
 * inputmode="none", so tapping the terminal dismisses the keyboard instead of
 * opening direct input, and typing into it (a hardware keyboard still
 * produces key events) or pasting into it is ignored. Data xterm produces on
 * its own keeps flowing: wheel reports from the touch scroll in mouse-tracking
 * apps, replies to terminal queries and the composer's term.paste. Back in
 * Direct mode both attributes are restored.
 *
 * Usable text (E2-FR-26..34): touchScroll.ts reports long-presses (select the
 * word and enter SelectionOverlay, with the input blurred so no keyboard),
 * taps on a URL or path (LinkSheet) and pinches (live CSS scale, then a snap
 * to the nearest text size preset). term.onScroll / onWriteParsed drive the
 * "New lines" pill and the scroll thumb.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { client, type TermFrame } from '../lib/client'
import { selectInputMode, useRemoteStore } from '../lib/store'
import type { InputMode } from '../lib/prefs'
import { FONT_SCALE_PRESETS, resetRatio, snapFontScale, solveFont } from '../lib/fit'
import { setActiveTerm } from '../lib/terminalBus'
import { getStoredHostPlatform } from '../lib/auth'
import { attachTouchScroll } from '../lib/touchScroll'
import { nextExit, useExitStore } from '../lib/exitState'
import { pointToCell, screenGeom, selectWordAt } from '../lib/selection'
import { linkAtCell, type TerminalLink } from '../lib/links'
import { CopyFallbackSheet, SelectionOverlay, type SelectionRange } from './SelectionOverlay'
import { LinkSheet } from './LinkSheet'
import { NewLinesPill } from './NewLinesPill'
import { SCROLL_THUMB_FADE_MS, ScrollThumb } from './ScrollThumb'

/** Apply the input mode to xterm's helper textarea (E1-FR-29). */
function applyInputMode(helper: HTMLTextAreaElement, mode: InputMode): void {
  const composer = mode === 'composer'
  helper.readOnly = composer
  if (composer) {
    helper.setAttribute('inputmode', 'none')
    if (document.activeElement === helper) helper.blur()
  } else {
    helper.removeAttribute('inputmode')
  }
}

/** Composer mode ignores typing and pasting into the terminal (E1-FR-29). */
function composerModeNow(): boolean {
  return selectInputMode(useRemoteStore.getState()) === 'composer'
}

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* no vibration without a gesture on some browsers */
  }
}

interface ScrollInfo {
  viewportY: number
  baseY: number
  rows: number
  track: number
}

export function RemoteTerminal(): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const colsRef = useRef(80)
  /** True when even MIN_FONT overflows the viewport (solveFont's overflow flag). */
  const overflowRef = useRef(false)
  /** Set once by the mount effect; lets the fontScale effect below re-run
   * the same cursor-follow pan logic without duplicating it out of scope. */
  const followCursorRef = useRef<() => void>(() => {})
  const xtermTheme = useRemoteStore((s) => s.xtermTheme)
  const fontScale = useRemoteStore((s) => s.fontScale)
  // Selection mode (E2-FR-26) and the link sheet (E2-FR-28/29).
  const [selection, setSelection] = useState<SelectionRange | null>(null)
  const selectionRef = useRef<SelectionRange | null>(null)
  selectionRef.current = selection
  const [link, setLink] = useState<TerminalLink | null>(null)
  const [copyFallback, setCopyFallback] = useState<string | null>(null)
  // "New lines" pill and scroll thumb (E2-FR-32/33).
  const [scroll, setScroll] = useState<ScrollInfo>({ viewportY: 0, baseY: 0, rows: 0, track: 0 })
  const [newLines, setNewLines] = useState(false)
  const [thumbVisible, setThumbVisible] = useState(false)
  const subscribedPaneId = useRemoteStore((s) => s.subscribedPaneId)
  const terminalUnicode = useRemoteStore((s) => s.terminalUnicode)
  const inputMode = useRemoteStore(selectInputMode)

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
    // Same cell widths as the desktop (E6-FR-15): the desktop says which table it
    // uses; without the field it is '6', xterm's built-in one.
    try {
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = useRemoteStore.getState().terminalUnicode
    } catch {
      /* keep xterm's built-in v6 table */
    }
    const detachTouchScroll = attachTouchScroll(term, container, {
      isSelecting: () => selectionRef.current != null,
      onLongPress: (x, y) => {
        const g = screenGeom(term)
        if (!g || x < g.left || x > g.left + g.width || y < g.top || y > g.top + g.height) return
        // No keyboard while selecting: the helper textarea gives up the focus.
        term.textarea?.blur()
        vibrate(10)
        setLink(null)
        setSelection(selectWordAt(term, pointToCell(g, x, y)))
      },
      onTap: (x, y) => {
        const g = screenGeom(term)
        if (!g || x < g.left || x > g.left + g.width || y < g.top || y > g.top + g.height) return false
        const cell = pointToCell(g, x, y)
        const found = linkAtCell(term, cell.col, cell.row)
        if (!found) return false
        setLink(found)
        return true
      },
      onPinch: (ratio) => {
        const el = term.element
        if (!el) return
        const scale = useRemoteStore.getState().fontScale
        const lo = FONT_SCALE_PRESETS[0] / scale
        const hi = FONT_SCALE_PRESETS[FONT_SCALE_PRESETS.length - 1] / scale
        el.style.transformOrigin = '0 0'
        el.style.transform = `scale(${Math.max(lo, Math.min(hi, ratio))})`
      },
      onPinchEnd: (ratio) => {
        const el = term.element
        if (el) el.style.transform = ''
        const st = useRemoteStore.getState()
        const next = snapFontScale(st.fontScale * ratio)
        if (next === st.fontScale) return
        vibrate(10)
        st.setFontScale(next)
      },
    })
    setActiveTerm(term)

    // Composer mode (E1-FR-29): a hardware keyboard still sends key events to
    // the readOnly helper and a paste still fires on it. Only those are
    // dropped, so wheel reports and query replies keep reaching the pty.
    term.attachCustomKeyEventHandler(() => !composerModeNow())
    const onPasteCapture = (e: ClipboardEvent): void => {
      if (!composerModeNow()) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    container.addEventListener('paste', onPasteCapture, true)

    // Best-effort hygiene on xterm's hidden input (item 5: iOS's input accessory
    // bar - the prev/next chevrons + close-keyboard button above the keyboard -
    // is OS chrome over any focused text field; no web API removes it. This does
    // NOT remove the bar, it only avoids opting into extra affordances on it.
    const helperTextarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (helperTextarea) {
      helperTextarea.setAttribute('autocorrect', 'off')
      helperTextarea.setAttribute('autocapitalize', 'off')
      helperTextarea.setAttribute('spellcheck', 'false')
      applyInputMode(helperTextarea, selectInputMode(useRemoteStore.getState()))
    }

    const applyFont = (): void => {
      const width = container.clientWidth || window.innerWidth
      const { fontSize, overflow } = solveFont(colsRef.current, width, useRemoteStore.getState().fontScale)
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

    // Pill and thumb state, read once per frame from the buffer.
    let scrollRaf: number | null = null
    let thumbTimer: ReturnType<typeof setTimeout> | null = null
    let prev = { viewportY: 0, baseY: 0 }
    let thumbOn = false
    const syncScroll = (): void => {
      scrollRaf = null
      const buf = term.buffer.active
      const next: ScrollInfo = { viewportY: buf.viewportY, baseY: buf.baseY, rows: term.rows, track: container.clientHeight }
      const followed = prev.viewportY >= prev.baseY && next.viewportY >= next.baseY
      // Only a real scroll shows the thumb, not output that follows the bottom.
      if (!followed && next.viewportY !== prev.viewportY) {
        thumbOn = true
        setThumbVisible(true)
        if (thumbTimer) clearTimeout(thumbTimer)
        thumbTimer = setTimeout(() => {
          thumbOn = false
          setThumbVisible(false)
        }, SCROLL_THUMB_FADE_MS)
      }
      if (next.viewportY >= next.baseY) setNewLines(false)
      prev = { viewportY: next.viewportY, baseY: next.baseY }
      // Streaming at the bottom with the thumb hidden: nothing on screen moves,
      // so skip the re-render on every frame of output.
      if (followed && !thumbOn) return
      setScroll((s) =>
        s.viewportY === next.viewportY && s.baseY === next.baseY && s.rows === next.rows && s.track === next.track ? s : next,
      )
    }
    const scheduleScroll = (): void => {
      if (scrollRaf == null) scrollRaf = requestAnimationFrame(syncScroll)
    }
    const scrollSub = term.onScroll(scheduleScroll)
    const parsedSub = term.onWriteParsed(() => {
      const buf = term.buffer.active
      if (buf.viewportY < buf.baseY) setNewLines(true)
      scheduleScroll()
    })

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
      // Exit strip above the KeyBar (E6-FR-20).
      const exitStore = useExitStore.getState()
      const exit = nextExit(exitStore.exit, useRemoteStore.getState().subscribedPaneId, f)
      if (exit !== exitStore.exit) exitStore.setExit(exit)
      if (f.type === 'replay') {
        colsRef.current = f.cols
        applyFont()
        try {
          term.resize(Math.max(1, f.cols), Math.max(1, f.rows))
          term.reset()
          // Widths must match before the replay is parsed, not after a re-render.
          const version = useRemoteStore.getState().terminalUnicode
          if (term.unicode.activeVersion !== version) term.unicode.activeVersion = version
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
      scrollSub.dispose()
      parsedSub.dispose()
      if (scrollRaf != null) cancelAnimationFrame(scrollRaf)
      if (thumbTimer) clearTimeout(thumbTimer)
      container.removeEventListener('paste', onPasteCapture, true)
      detachTouchScroll()
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

  // Follow the viewed pane's input mode. A layout effect, so a mode toggled
  // inside flushSync is in place before the caller moves the focus.
  useLayoutEffect(() => {
    const helper = containerRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (helper) applyInputMode(helper, inputMode)
  }, [inputMode])

  // Live theme swap.
  useEffect(() => {
    const term = termRef.current
    if (term && xtermTheme) term.options.theme = xtermTheme
  }, [xtermTheme])

  // The desktop toggled its Unicode width table: follow it live.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      if (term.unicode.activeVersion === terminalUnicode) return
      term.unicode.activeVersion = terminalUnicode
      term.refresh(0, term.rows - 1)
    } catch {
      /* addon missing or terminal torn down */
    }
  }, [terminalUnicode])

  // Text size preset (pinch or Settings, E2-FR-34). Must sync overflowRef too:
  // solveFont's overflow flag is what the cursor-follow effect above reads, and
  // this is the only other place fontSize (hence overflow) can change.
  useEffect(() => {
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return
    const width = container.clientWidth || window.innerWidth
    const { fontSize, overflow } = solveFont(colsRef.current, width, fontScale)
    term.options.fontSize = fontSize
    overflowRef.current = overflow
    followCursorRef.current()
  }, [fontScale])

  // Switching panes: clear the stale content immediately so the gap before the
  // new pane's replay lands is blank, not the previous console's output.
  useEffect(() => {
    const term = termRef.current
    // The strip belongs to the previous console; the new one's replay sets its own.
    const exit = useExitStore.getState().exit
    if (exit && exit.paneId !== subscribedPaneId) useExitStore.getState().setExit(null)
    setSelection(null)
    setLink(null)
    setNewLines(false)
    if (term && subscribedPaneId) {
      try {
        term.reset()
      } catch {
        /* ignore */
      }
    }
  }, [subscribedPaneId])

  const exitSelection = useCallback((): void => {
    try {
      termRef.current?.clearSelection()
    } catch {
      /* torn down */
    }
    setSelection(null)
  }, [])

  const term = termRef.current
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: 'var(--color-bg-primary)' }}>
      <div
        ref={containerRef}
        data-scrollable
        className="h-full w-full overflow-x-auto overflow-y-hidden"
        style={{ WebkitTouchCallout: 'none' }}
      />
      <ScrollThumb visible={thumbVisible} viewportY={scroll.viewportY} baseY={scroll.baseY} rows={scroll.rows} trackPx={scroll.track} />
      <NewLinesPill visible={newLines && scroll.viewportY < scroll.baseY} onTap={() => termRef.current?.scrollToBottom()} />
      {selection && term && (
        <SelectionOverlay term={term} range={selection} onRange={setSelection} onExit={exitSelection} onCopyFallback={setCopyFallback} />
      )}
      <LinkSheet link={link} onClose={() => setLink(null)} onCopyFallback={setCopyFallback} />
      <CopyFallbackSheet text={copyFallback} onClose={() => setCopyFallback(null)} />
    </div>
  )
}
