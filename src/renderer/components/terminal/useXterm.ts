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
import { registerRedrawer, unregisterRedrawer } from '@/lib/redrawRegistry'

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
 * Renderer policy. The recurring "garbled glyphs / mojibake" bug is caused by
 * xterm's WebGL renderer: a GPU reset (sleep/resume, screen unlock, Windows
 * TDR, GPU-process crash) can hand its WebGL2 context back ALIVE BUT INVALID,
 * with the glyph texture atlas trashed, while firing NO webglcontextlost event,
 * raising no GL error, and reporting gl.isContextLost()===false. There is no
 * reliable signal to react to, so every event-driven heal eventually misses a
 * path and the panes stay garbled (the bug recurred across v1.4.5-v1.4.7, each
 * release just bolting on one more trigger).
 *
 * The real cure is to stop keeping a corruptible GPU atlas at all: the 2D
 * Canvas renderer is now the DEFAULT. It holds no app-owned WebGL context and
 * no sampled GPU texture, so a backing-store loss is deterministic (Chromium
 * re-creates it blank) and the worst case is a blank glyph that repaints on the
 * next output, never a wrong (garbled) glyph. WebGL stays available as an opt-in
 * (settings.terminalRenderer === 'webgl') for users who want its throughput and
 * accept the reset risk; for that path we keep the recreate-on-event heal and
 * the manual Ctrl+Shift+R redraw as defense in depth.
 *
 * Browsers also cap live WebGL contexts (~16 in Chromium) and evict the oldest,
 * which silently drops a running terminal to the DOM renderer (garbles +
 * duplicates lines). The opt-in WebGL path therefore still caps itself at
 * MAX_WEBGL and, on a true onContextLoss, degrades to Canvas (never DOM).
 *
 * loadRenderer returns a handle: heal() applies the cheapest correct repair for
 * the live renderer (clearTextureAtlas + refresh for Canvas, full recreate for
 * WebGL's zombie context); reload() always fully rebuilds (the manual escape
 * hatch); dispose() frees any WebGL slot. See
 * https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md
 */
let webglContexts = 0
const MAX_WEBGL = 8

interface RendererHandle {
  /** Renderer-appropriate repair: cheap atlas refresh for Canvas, full recreate for WebGL. */
  heal: () => void
  /** Dispose the current addon and mount a fresh one, then repaint (manual redraw). */
  reload: () => void
  /** Teardown for unmount: dispose the current addon and free any WebGL slot. */
  dispose: () => void
}

function loadRenderer(term: Terminal, getRenderer: () => 'canvas' | 'webgl'): RendererHandle {
  let current: WebglAddon | CanvasAddon | null = null
  // What `current` actually is, so heal() can pick the right repair.
  let currentKind: 'webgl' | 'canvas' | 'dom' = 'dom'
  // True only while `current` is a WebglAddon counted in webglContexts.
  let holdsSlot = false
  let handleDisposed = false

  // Free this handle's WebGL slot at most once, so the shared counter can never
  // underflow (double release) however many panes reload at the same time.
  const releaseSlot = (): void => {
    if (!holdsSlot) return
    holdsSlot = false
    webglContexts--
  }

  // Tear down whatever is mounted and free its slot. Release BEFORE dispose so a
  // same-tick remount sees the slot free and re-acquires WebGL (instead of
  // silently downgrading itself to Canvas on every reload).
  const teardownCurrent = (): void => {
    const addon = current
    current = null
    currentKind = 'dom'
    releaseSlot()
    if (addon) {
      try {
        addon.dispose()
      } catch {
        /* already gone */
      }
    }
  }

  // Mount the WebGL renderer if a context slot is free. Returns true on success.
  const mountWebgl = (): boolean => {
    if (webglContexts >= MAX_WEBGL) return false
    try {
      const webgl = new WebglAddon()
      webglContexts++
      holdsSlot = true
      current = webgl
      currentKind = 'webgl'
      // A TRUE context loss degrades permanently to Canvas (recreating WebGL
      // here could loop recreate -> lose). Route through teardownCurrent so a
      // later reload() can't double-dispose this addon or miscount the slot;
      // bail if a reload()/dispose() already replaced us.
      webgl.onContextLoss(() => {
        if (handleDisposed || current !== webgl) return
        teardownCurrent()
        mountCanvas()
      })
      term.loadAddon(webgl)
      return true
    } catch {
      // WebGL2 unsupported / construction failed: undo the optimistic bump.
      releaseSlot()
      return false
    }
  }

  // Mount the 2D Canvas renderer. Returns true on success.
  const mountCanvas = (): boolean => {
    try {
      const canvas = new CanvasAddon()
      current = canvas
      currentKind = 'canvas'
      term.loadAddon(canvas)
      return true
    } catch {
      return false
    }
  }

  // Mount the renderer for the current preference. Canvas is the default; WebGL
  // only when explicitly opted in. If the preferred engine fails to construct,
  // try the other before falling back to xterm's DOM renderer (the known
  // glyph-garbling path), which we therefore only reach as a last resort and
  // announce so it is never a silent downgrade.
  const mount = (): void => {
    const pref = getRenderer()
    if (pref === 'webgl') {
      if (mountWebgl()) return
    }
    if (mountCanvas()) return
    if (pref !== 'webgl' && mountWebgl()) return
    current = null
    currentKind = 'dom'
    console.warn(
      '[snmulticc] no GPU/2D renderer available; using xterm DOM renderer (known to garble under heavy redraw)',
    )
  }

  // Full rebuild: fresh canvas + (for WebGL) fresh GL context + atlas, repainted
  // from the intact buffer. Re-reads the preference, so toggling the setting and
  // then triggering a rebuild switches engine.
  const rebuild = (): void => {
    teardownCurrent()
    mount()
    try {
      term.refresh(0, term.rows - 1)
    } catch {
      /* renderer mid-teardown */
    }
  }

  mount()

  return {
    heal: (): void => {
      if (handleDisposed) return
      // A WebGL zombie context must be fully recreated; a Canvas pane only needs
      // its atlas dropped and a repaint (a full addon teardown on every focus
      // would blank-flash every visible pane on each alt-tab for no reason).
      if (currentKind === 'webgl') {
        rebuild()
        return
      }
      try {
        term.clearTextureAtlas()
        term.refresh(0, term.rows - 1)
      } catch {
        /* renderer mid-teardown */
      }
    },
    reload: (): void => {
      if (handleDisposed) return
      rebuild()
    },
    dispose: (): void => {
      if (handleDisposed) return
      handleDisposed = true
      teardownCurrent()
    },
  }
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
  /** A heal was requested while this pane was hidden; applied on next reveal. */
  const healPendingRef = useRef(false)
  /** Latest gated heal fn; reused by the reveal effect. */
  const healRef = useRef<() => void>(() => undefined)

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
      // Pin weights to faces we actually ship (see main.tsx). xterm's default
      // bold is 'bold' (700); if that face is missing the renderer fakes it,
      // producing uneven thick glyphs next to the crisp 400s.
      fontWeight: 400,
      fontWeightBold: 700,
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
    // Reading the preference inside the closure means mount() AND reload() always
    // re-read the CURRENT setting, so toggling the renderer then redrawing a pane
    // actually switches engine.
    const rendererHandle = loadRenderer(term, () => useAppStore.getState().settings.terminalRenderer)

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
      // A visible (focusable) pane always lives in the active workspace, so we
      // can tag this pane as that workspace's last-used console for switch focus.
      setFocusedPane(opts.paneId, useAppStore.getState().activeWorkspaceId ?? undefined)
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
    // Manual escape hatch for garbled glyphs (pane menu / keybinding): rebuild
    // the renderer immediately, no debounce, since the user is reacting to
    // visible corruption right now.
    registerRedrawer(opts.paneId, () => rendererHandle.reload())

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
          // Route through xterm's paste rather than writing the raw clipboard:
          // it normalizes CRLF/LF to CR and, when the inner app enabled
          // bracketed-paste mode, wraps the text in paste markers so a
          // multi-line paste is inserted as one literal block instead of each
          // line running as a command. The onData handler below forwards it to
          // the pty, where PtyManager paces the write so ConPTY can't drop a
          // large paste.
          if (text) term.paste(text)
        })
        return false
      }
      return true
    })

    let disposed = false
    let offData: () => void = () => undefined
    let offExit: () => void = () => undefined

    // Cold start: the first pane can mount before the JetBrains Mono web font
    // finishes loading, so xterm builds its glyph atlas from the fallback font
    // (wrong metrics + wrong weights). Once the real faces (incl. bold/italic)
    // are ready, drop the stale atlas and repaint so every glyph re-rasterizes
    // at the correct weight.
    void document.fonts.ready.then(() => {
      if (disposed) return
      try {
        term.clearTextureAtlas()
        refitRef.current()
        term.refresh(0, term.rows - 1)
      } catch {
        /* terminal torn down between the guard and here */
      }
    })

    // Renderer self-heal on a display recovery. With Canvas as the default this
    // is cheap insurance: rendererHandle.heal() drops the atlas and repaints,
    // which cures Canvas's one residual (a blank/missing glyph after a
    // backing-store reset) without a full addon teardown. For an opt-in WebGL
    // pane, heal() instead fully recreates the renderer (fresh canvas + GL
    // context), because a GPU reset can hand WebGL back a context that is alive
    // but invalid (trashed atlas) without firing webglcontextlost, and clearing
    // the atlas alone just re-uploads into that zombie context. We heal when
    // main signals a recovery, and as a catch-all whenever the window regains
    // OS focus (covers a GPU reset that fired no power/metrics event).
    let healTimer: ReturnType<typeof setTimeout> | undefined
    const healAtlas = (): void => {
      // Only rebuild a pane that's actually on screen and measurable. Reloading
      // a hidden (display:none / zero-size) pane just churns its GL context and
      // repaints nothing, and on a single window-restore EVERY mounted pane
      // would fire at once (each visited workspace stays mounted). Defer instead
      // and heal once the pane is revealed (see the reveal effect below).
      if (
        !activeRef.current ||
        !container ||
        container.clientWidth < 8 ||
        container.clientHeight < 8
      ) {
        healPendingRef.current = true
        return
      }
      clearTimeout(healTimer)
      // Right after resume the GPU may still be re-initializing; recreating a
      // beat too early would build the fresh context against a half-restored
      // GPU. The debounce also coalesces an alt-tab burst into one reload.
      healTimer = setTimeout(() => {
        if (disposed) return
        healPendingRef.current = false
        try {
          rendererHandle.heal()
        } catch {
          /* renderer mid-teardown */
        }
      }, 300)
    }
    healRef.current = healAtlas
    const offDisplayRecovered = window.snApi.system.onDisplayRecovered(healAtlas)
    window.addEventListener('focus', healAtlas)
    // A GPU reset can lose then restore the SAME WebGL context while the window
    // stays focused and visible (so neither focus nor display-recovered fires);
    // the restored context comes back with a trashed atlas. The event targets
    // the addon's canvas and does not bubble, so catch it on the container in
    // the capture phase and rebuild. (Only the opt-in WebGL path emits this.)
    container.addEventListener('webglcontextrestored', healAtlas, true)
    // Canvas equivalent: a 2D canvas whose backing store was reset fires
    // 'contextrestored' (not 'webglcontextrestored'). Catch it the same way so a
    // static Canvas pane that lost its backing during sleep repaints at once
    // instead of waiting for the next output/scroll.
    container.addEventListener('contextrestored', healAtlas, true)

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
      rendererHandle.dispose()
      clearTimeout(healTimer)
      offDisplayRecovered()
      window.removeEventListener('focus', healAtlas)
      container.removeEventListener('webglcontextrestored', healAtlas, true)
      container.removeEventListener('contextrestored', healAtlas, true)
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
      unregisterRedrawer(opts.paneId)
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
    const raf = requestAnimationFrame(() => {
      refitRef.current()
      // Apply a heal that was deferred while this pane was hidden (e.g. a GPU
      // reset during sleep while another workspace was shown). Now that the box
      // is measurable, the gated heal will actually rebuild the renderer.
      if (healPendingRef.current) healRef.current()
    })
    return () => cancelAnimationFrame(raf)
  }, [opts.isActive])

  return controllerRef.current
}
