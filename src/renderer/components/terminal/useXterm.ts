import { useEffect, useRef, type RefObject } from 'react'
import type { SetupStep } from '@shared/types'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '@/lib/store'
import { buildXtermTheme } from '@/themes'
import { registerPty, unregisterPty } from '@/lib/ptyRegistry'
import { registerFocuser, setFocusedPane, unregisterFocuser } from '@/lib/focus'

/** Line cap used to emulate "infinite" scrollback (like a normal terminal). */
const INFINITE_SCROLLBACK = 100000

/** Highlight palette for in-pane search matches. */
const SEARCH_OPTS = {
  decorations: {
    matchBackground: '#8b5cf688',
    activeMatchBackground: '#6366f1',
    matchOverviewRuler: '#8b5cf6',
    activeMatchColorOverviewRuler: '#a78bfa',
  },
}

/**
 * Browsers cap live WebGL contexts (~16 in Chromium). Past that, Chromium
 * EVICTS the oldest context, so an already-running terminal loses its GPU
 * context and (previously) silently fell to the slow DOM renderer, which
 * garbles and duplicates lines while an AI CLI is redrawing. We avoid that two
 * ways: (a) cap how many panes use WebGL so eviction never triggers, and (b) on
 * a context loss fall back to the 2D Canvas renderer, never the DOM renderer.
 * Returns a release fn that frees the WebGL slot on teardown.
 */
let webglContexts = 0
const MAX_WEBGL = 8

function loadRenderer(term: Terminal): () => void {
  if (webglContexts < MAX_WEBGL) {
    try {
      const webgl = new WebglAddon()
      webglContexts++
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        webglContexts--
      }
      webgl.onContextLoss(() => {
        release()
        try {
          webgl.dispose()
        } catch {
          /* already gone */
        }
        try {
          term.loadAddon(new CanvasAddon())
        } catch {
          /* fall back to the default DOM renderer */
        }
      })
      term.loadAddon(webgl)
      return release
    } catch {
      /* WebGL2 unsupported, fall through to Canvas */
    }
  }
  try {
    term.loadAddon(new CanvasAddon())
  } catch {
    /* default DOM renderer */
  }
  return () => undefined
}

/** Imperative handle returned by useXterm, used by chrome (find bar, focus). */
export interface XtermController {
  /** Search the scrollback; returns whether a match was found. */
  search: (query: string, opts?: { back?: boolean }) => boolean
  /** Clear search highlights. */
  clearSearch: () => void
  /** Focus the terminal input. */
  focus: () => void
}

export interface UseXtermOptions {
  /** Stable pane id (ties this terminal to a workspace pane). */
  paneId: string
  cwd?: string
  shell?: string
  /** Command line typed into the shell after spawn (e.g. an AI CLI). */
  initialCommand?: string
  /** Pre-launch sequence (e.g. SSH connect) run before initialCommand. */
  setup?: SetupStep[]
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
 * teardown (pane/workspace removal), NOT on theme/font/visibility changes,
 * so running sessions survive workspace switches.
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  opts: UseXtermOptions,
): XtermController {
  const ptyIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  /** Latest guarded fit fn; reused by the font-size + reveal effects. */
  const refitRef = useRef<() => void>(() => undefined)
  const controllerRef = useRef<XtermController>({
    search: () => false,
    clearSearch: () => undefined,
    focus: () => undefined,
  })
  // Backpressure bookkeeping (kept in refs so the reveal effect can reset it).
  const pendingRef = useRef(0)
  const pausedRef = useRef(false)
  const activeRef = useRef<boolean>(Boolean(opts.isActive))

  const theme = useAppStore((s) => s.settings.theme)
  const customColors = useAppStore((s) => s.settings.customColors)
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const infiniteScrollback = useAppStore((s) => s.settings.infiniteScrollback)
  const scrollback = useAppStore((s) => s.settings.scrollback)
  const effectiveFontSize = opts.fontSize ?? fontSize

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
      // Blink only while focused (toggled in focusin/out below) so idle panes
      // don't each schedule a repaint twice a second forever.
      cursorBlink: false,
      scrollback: settings.infiniteScrollback ? INFINITE_SCROLLBACK : (settings.scrollback ?? 5000),
      allowProposedApi: true,
      // Windows ConPTY emits long lines without reliable native wrap markers,
      // so xterm can't tell a soft-wrapped row from a hard line break: links
      // and selections then stop at the wrap boundary (a URL split over two
      // rows only half-detects). Enabling windowsPty turns on the heuristic
      // "a full row whose last cell isn't blank continues on the next row",
      // which lets the web-links addon join the wrapped URL. Omitting
      // buildNumber keeps the heuristic on regardless of the OS build.
      ...(window.snApi.platform === 'win32'
        ? { windowsPty: { backend: 'conpty' as const } }
        : {}),
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    term.loadAddon(fit)
    // Custom handler: hand the URL straight to the OS browser via IPC. The
    // addon's default opens window.open() with no URL (about:blank), which the
    // sandboxed renderer can't navigate, so links appeared dead.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.snApi.system.openExternal(uri)))
    term.loadAddon(search)
    term.open(container)
    const releaseRenderer = loadRenderer(term)

    // Track the last geometry pushed to the pty so we never spam pty.resize and
    // never settle on a bad fit. -1 forces the first real fit to propagate.
    let lastCols = -1
    let lastRows = -1
    // Fit only when the container is actually measurable. A display:none or
    // mid-relayout box yields a bogus tiny geometry, that is the "everything
    // crammed into a narrow column / text floating to one side" bug. We also
    // tell the pty only when cols/rows truly change, so an AI CLI redrawing
    // isn't interrupted by a stream of no-op SIGWINCH resizes.
    const safeFit = (): void => {
      if (!container || container.clientWidth < 8 || container.clientHeight < 8) return

      // Re-anchor the viewport across the refit. A resize reflow (a window drag
      // on fractional-DPI Windows nudges rows/cols by a line) makes xterm pull
      // scrollback in and drag the viewport upward. Remember where the user was,
      // pinned to the live bottom or N rows up the scrollback, and restore it
      // after the fit.
      const buf = term.buffer.active
      const fromBottom = buf.baseY - buf.viewportY
      try {
        fit.fit()
      } catch {
        return
      }
      if (fromBottom <= 0) term.scrollToBottom()
      else term.scrollToLine(Math.max(0, term.buffer.active.baseY - fromBottom))
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      const id = ptyIdRef.current
      if (id) window.snApi.pty.resize({ ptyId: id, cols: term.cols, rows: term.rows })
    }
    refitRef.current = safeFit
    // Size synchronously so the pty spawns at the right cols/rows when the box
    // is already laid out; the double-rAF below covers reveal/animation cases.
    safeFit()

    // Cursor blinks only while this terminal has focus.
    const onFocusIn = (): void => {
      term.options.cursorBlink = true
      setFocusedPane(opts.paneId)
    }
    const onFocusOut = (): void => {
      term.options.cursorBlink = false
    }
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)

    // Wheel-scroll "sticks" short of the newest output: after a burst (an AI CLI
    // streaming, or just the tail of a command) xterm defers its scroll-area
    // resize to the next frame, and a fractional cell height (Windows display
    // scaling) can round the DOM scroll-max to one row above the buffer's true
    // bottom. The viewport then parks at ybase-k and the wheel can't advance
    // past the stale clamp; only a keypress (which force-scrolls to bottom)
    // reveals the tail. When a downward wheel leaves us demonstrably stuck (no
    // movement) at the end of the scrollback, finish the scroll for the user.
    const viewportEl = container.querySelector<HTMLElement>('.xterm-viewport')
    const SNAP_ROWS = 4
    let snapRaf = 0
    const onWheelSnap = (e: WheelEvent): void => {
      // Ctrl/Cmd+wheel is zoom (handled by TerminalPane); Shift+wheel is
      // horizontal. Only react to a plain downward scroll.
      if (e.deltaY <= 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
      const before = term.buffer.active.viewportY
      cancelAnimationFrame(snapRaf)
      // xterm applies the scroll and updates ydisp over the next frame; re-check
      // once it settles. A burst of wheels coalesces to one check on the last
      // event, so we never snap mid-scroll.
      snapRaf = requestAnimationFrame(() => {
        const buf = term.buffer.active
        // Full-screen apps (vim, less, htop) use the alternate buffer with no
        // scrollback, so snapping their viewport would be wrong.
        if (buf.type !== 'normal') return
        // The wheel moved us, or we're already at the bottom: not stuck.
        if (buf.viewportY !== before || buf.viewportY >= buf.baseY) return
        // Confirm we're genuinely at the tail, not mid-scrollback (where slow
        // sub-row touchpad deltas can also leave ydisp unchanged). Snap if the
        // DOM scroller is pinned at its max (the stale-clamp case, any stall
        // size) or we're within a couple rows of the bottom (the round-off
        // case, covering the frame where xterm already healed the scroll area).
        const atDomMax =
          !!viewportEl &&
          viewportEl.scrollTop + viewportEl.clientHeight >= viewportEl.scrollHeight - 1
        if (atDomMax || buf.baseY - buf.viewportY <= SNAP_ROWS) {
          term.scrollToBottom()
        }
      })
    }
    container.addEventListener('wheel', onWheelSnap, { passive: true })

    // Wire the imperative handle now that the addons exist.
    controllerRef.current.search = (query, o) => {
      if (!query) {
        search.clearDecorations()
        return false
      }
      return o?.back ? search.findPrevious(query, SEARCH_OPTS) : search.findNext(query, SEARCH_OPTS)
    }
    controllerRef.current.clearSearch = () => search.clearDecorations()
    controllerRef.current.focus = () => term.focus()
    registerFocuser(opts.paneId, () => term.focus())

    // Terminal copy/paste via the Electron clipboard. Ctrl+C copies the
    // selection (else falls through to ^C / interrupt); Ctrl+V pastes;
    // Ctrl+Shift+C / Ctrl+Shift+V are explicit copy/paste.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return true
      const key = e.key.toLowerCase()
      // Ctrl+Enter inserts a newline in AI CLIs (Claude Code, etc.) instead of
      // submitting. A terminal sends the same CR for Enter and Ctrl+Enter, so
      // the inner app can't tell them apart; we remap Ctrl+Enter to ESC+CR
      // (meta+enter), which those tools treat as "insert newline". Plain Enter
      // is left untouched so normal submitting still works.
      if (key === 'enter' && e.ctrlKey && !e.shiftKey) {
        e.preventDefault()
        const id = ptyIdRef.current
        if (id) window.snApi.pty.write({ ptyId: id, data: '\x1b\r' })
        return false
      }
      if (key === 'c') {
        if (term.hasSelection()) {
          e.preventDefault()
          window.snApi.clipboard.writeText(term.getSelection())
          return false
        }
        if (e.shiftKey) {
          e.preventDefault()
          return false
        }
        return true // nothing selected → let ^C interrupt the process
      }
      if (key === 'v') {
        e.preventDefault()
        void window.snApi.clipboard.readText().then((text) => {
          const id = ptyIdRef.current
          if (id && text) window.snApi.pty.write({ ptyId: id, data: text })
        })
        return false
      }
      return true
    })

    let disposed = false
    let offData: () => void = () => undefined
    let offExit: () => void = () => undefined

    // Backpressure: throttle a chatty *visible* pty when xterm can't drain.
    // Hidden panes are NEVER paused, background agents must keep running, and a
    // display:none xterm may not fire write callbacks, which would otherwise
    // stall the pty (freezing its activity state). See the reveal effect below.
    const HIGH_WATER = 1_000_000
    const LOW_WATER = 200_000
    pendingRef.current = 0
    pausedRef.current = false

    const bind = (ptyId: string): void => {
      ptyIdRef.current = ptyId
      registerPty(opts.paneId, ptyId)
      offData = window.snApi.pty.onData((e) => {
        if (e.ptyId !== ptyId) return
        pendingRef.current += e.data.length
        if (activeRef.current && !pausedRef.current && pendingRef.current > HIGH_WATER) {
          pausedRef.current = true
          window.snApi.pty.flow({ ptyId, pause: true })
        }
        term.write(e.data, () => {
          pendingRef.current -= e.data.length
          if (pausedRef.current && pendingRef.current < LOW_WATER) {
            pausedRef.current = false
            window.snApi.pty.flow({ ptyId, pause: false })
          }
        })
      })
      offExit = window.snApi.pty.onExit((e) => {
        if (e.ptyId === ptyId) {
          term.write(`\r\n\x1b[2m[process exited (${e.exitCode})]\x1b[0m\r\n`)
        }
      })
    }

    // Rebind to an already-running pty (renderer reload / remount) when one
    // exists for this pane; otherwise spawn a fresh shell.
    window.snApi.pty
      .reattach(opts.paneId)
      .then((existing) => {
        if (disposed) return undefined
        if (existing) {
          if (existing.replay) term.write(existing.replay)
          bind(existing.ptyId)
          return undefined
        }
        return window.snApi.pty
          .spawn({
            paneId: opts.paneId,
            shell: opts.shell,
            cwd: opts.cwd,
            initialCommand: opts.initialCommand,
            setup: opts.setup,
            cols: term.cols,
            rows: term.rows,
          })
          .then(({ ptyId }) => {
            if (disposed) {
              void window.snApi.pty.kill(ptyId)
              return
            }
            bind(ptyId)
          })
      })
      .catch((err) => term.write(`\r\n\x1b[31mFailed to start shell: ${String(err)}\x1b[0m\r\n`))

    const input = term.onData((data) => {
      const id = ptyIdRef.current
      if (id) window.snApi.pty.write({ ptyId: id, data })
    })

    // Coalesce resize bursts (CSS-grid reflow, window drag, the spring layout
    // animation) into a single fit per frame; safeFit's diff guard suppresses
    // redundant pty.resize calls so a busy console doesn't glitch mid-redraw.
    let roRaf = 0
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(roRaf)
      roRaf = requestAnimationFrame(safeFit)
    })
    resizeObserver.observe(container)
    // Framer-motion finishes its layout animation via a CSS transform, which
    // does NOT fire the ResizeObserver, so re-fit once the box has settled.
    const mountRaf = requestAnimationFrame(() => requestAnimationFrame(safeFit))

    return () => {
      disposed = true
      cancelAnimationFrame(roRaf)
      cancelAnimationFrame(mountRaf)
      cancelAnimationFrame(snapRaf)
      resizeObserver.disconnect()
      releaseRenderer()
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      container.removeEventListener('wheel', onWheelSnap)
      input.dispose()
      offData()
      offExit()
      const id = ptyIdRef.current
      if (id) void window.snApi.pty.kill(id)
      unregisterPty(opts.paneId)
      unregisterFocuser(opts.paneId)
      ptyIdRef.current = null
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      controllerRef.current = {
        search: () => false,
        clearSearch: () => undefined,
        focus: () => undefined,
      }
      refitRef.current = () => undefined
      term.dispose()
      startedRef.current = false
    }
    // Spawn ONCE per pane. cwd/shell/initialCommand are captured at mount, so
    // editing a preset's command only affects NEW consoles and never restarts
    // already-running ones. Theme/font/visibility update via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, opts.paneId])

  // Live theme updates, swap the palette in place.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = buildXtermTheme(theme, customColors)
  }, [theme, customColors])

  // Live font-size updates, per-pane override wins over the global size.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = effectiveFontSize
    // A font change alters cell size ⇒ cols/rows change, so the guarded refit
    // re-fits and propagates the new geometry to the pty.
    refitRef.current()
  }, [effectiveFontSize])

  // Live scrollback updates (infinite ⇒ effectively unbounded buffer).
  useEffect(() => {
    const term = termRef.current
    if (term) {
      term.options.scrollback = infiniteScrollback ? INFINITE_SCROLLBACK : (scrollback ?? 5000)
    }
  }, [infiniteScrollback, scrollback])

  // Track visibility for backpressure; on reveal, drop any stale pending count
  // (a hidden xterm may not have fired its write callbacks) and unpause.
  useEffect(() => {
    activeRef.current = Boolean(opts.isActive)
    if (opts.isActive) {
      pendingRef.current = 0
      if (pausedRef.current) {
        pausedRef.current = false
        const id = ptyIdRef.current
        if (id) window.snApi.pty.flow({ ptyId: id, pause: false })
      }
    }
  }, [opts.isActive])

  // Refit when this terminal becomes visible (hidden xterms can't measure).
  useEffect(() => {
    if (!opts.isActive) return
    const raf = requestAnimationFrame(() => refitRef.current())
    return () => cancelAnimationFrame(raf)
  }, [opts.isActive])

  return controllerRef.current
}
