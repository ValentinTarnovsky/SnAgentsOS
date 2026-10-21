/**
 * xterm renderer policy and loader, shared by the local terminal (useXterm)
 * and the guest view of a shared console (share/useRemoteXterm). Moved out of
 * useXterm.ts unchanged (app 2.4.0); the WebGL slot counter is one per window
 * for both.
 */
import type { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { BRAND } from '@shared/brand'

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

export interface RendererHandle {
  /** Renderer-appropriate repair: cheap atlas refresh for Canvas, full recreate for WebGL. */
  heal: () => void
  /** Dispose the current addon and mount a fresh one, then repaint (manual redraw). */
  reload: () => void
  /** Teardown for unmount: dispose the current addon and free any WebGL slot. */
  dispose: () => void
}

export function loadRenderer(term: Terminal, getRenderer: () => 'canvas' | 'webgl'): RendererHandle {
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
      `[${BRAND.packageName}] no GPU/2D renderer available; using xterm DOM renderer (known to garble under heavy redraw)`,
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
