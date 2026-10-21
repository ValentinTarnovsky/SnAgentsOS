import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { REPORTS_ONLY_RE } from '@shared/inputReports'
import { ShareInputGate, type ShareInputCtx } from '@shared/shareInput'
import type { ShareHostPlatform, SharePerm } from '@shared/share-protocol'
import { useAppStore } from '@/lib/store'
import { buildXtermTheme } from '@/themes'
import { FIT_MIN_FONT, fitGeometry } from '@/lib/fitStore'
import { registerShareTerm, useShareGuestStore, type ShareNoticeReason, type ShareTermItem } from '@/lib/shareGuestStore'
import { loadRenderer } from '@/components/terminal/xtermRenderer'

/** Mirror of useXterm's backpressure marks: pending term.write bytes. */
export const SHARE_HIGH_WATER = 1_000_000
export const SHARE_LOW_WATER = 200_000
/** Scrollback of a shared console (the host replays at most 2000 lines). */
const SCROLLBACK = 5000

/** The css cell size xterm renders with (FitAddon's private path), or null before it measured. */
function cellOf(term: Terminal): { w: number; h: number } | null {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core
  const cell = core?._renderService?.dimensions?.css?.cell
  return cell && cell.width > 0 && cell.height > 0 ? { w: cell.width, h: cell.height } : null
}

function scrollBarWidth(term: Terminal): number {
  const core = (term as unknown as { _core?: { viewport?: { scrollBarWidth?: number } } })._core
  return core?.viewport?.scrollBarWidth ?? 0
}

export interface UseRemoteXtermOptions {
  linkId: string
  paneId: string
  /** The permission in force (live: a permChanged applies at once). */
  perm: SharePerm
  /** Another party holds the input lease: keys are refused locally meanwhile. */
  lock: 'host' | 'other' | null
  /** The host's label, shown in ConfirmLinkDialog. */
  hostLabel: string
  hostPlatform: ShareHostPlatform
  /** The host's terminalUnicode11 (cell widths must match the host's). */
  unicode11: boolean
  /** What the pre-check knows of the pane (agent, status), read on every key. */
  ctx: () => Omit<ShareInputCtx, 'lastByte'>
  /** A write refused before it left the renderer. */
  onRefused: (reason: ShareNoticeReason) => void
  /** Strings written into the terminal itself. */
  exitLine: (code: number | null) => string
}

export interface RemoteXtermController {
  focus: () => void
}

/**
 * The guest's xterm for one shared console (app 2.4.0, item 8, S3). The
 * host's output is untrusted:
 * - the grid is the host's (replay/fit cols x rows); the font shrinks to fit
 *   the cell, down to 6 px, then the area scrolls. The host pty is NEVER
 *   resized from here: there is no resize call at all;
 * - OSC 52 (clipboard) is swallowed, OSC 7 and 133 ignored, titles and the
 *   bell never wired, no image addon; links (OSC 8 and plain URLs) only open
 *   through ConfirmLinkDialog;
 * - nothing is registered in the local registries (pty, paste, focus,
 *   readers, redraw, marks), so no local feature can target this terminal.
 * Input: none in `view` (helper textarea readOnly, stdin disabled); terminal
 * reports other than mouse in `full` are dropped; `type` is pre-checked with
 * the same ShareInputGate the host runs, so a refused key shows at once.
 */
export function useRemoteXterm(containerRef: RefObject<HTMLDivElement | null>, opts: UseRemoteXtermOptions): RemoteXtermController {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const termRef = useRef<Terminal | null>(null)
  const refitRef = useRef<() => void>(() => undefined)
  const controllerRef = useRef<RemoteXtermController>({ focus: () => undefined })

  const theme = useAppStore((s) => s.settings.theme)
  const customColors = useAppStore((s) => s.settings.customColors)
  const fontSize = useAppStore((s) => s.settings.fontSize)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const { linkId, paneId } = optsRef.current
    const api = window.snApi.share.guest
    const settings = useAppStore.getState().settings
    const normalFont = (): number => useAppStore.getState().settings.fontSize ?? 13
    const confirm = (uri: string): void => useShareGuestStore.getState().confirmLink(uri, optsRef.current.hostLabel)

    const term = new Terminal({
      fontFamily: settings.fontFamily || "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      fontSize: normalFont(),
      fontWeight: 400,
      fontWeightBold: 700,
      theme: buildXtermTheme(settings.theme, settings.customColors),
      cursorBlink: false,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
      disableStdin: optsRef.current.perm === 'view',
      // The host's ConPTY wraps like the local one: the same heuristic joins wrapped URLs.
      ...(optsRef.current.hostPlatform === 'win32' ? { windowsPty: { backend: 'conpty' as const } } : {}),
      // OSC 8 hyperlinks: the full URL goes through the confirmation, never straight out.
      linkHandler: { activate: (_e, text) => confirm(text) },
    })
    termRef.current = term
    term.loadAddon(new WebLinksAddon((_e, uri) => confirm(uri)))
    term.open(container)
    try {
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = optsRef.current.unicode11 ? '11' : '6'
    } catch {
      /* keep the built-in v6 table */
    }
    const rendererHandle = loadRenderer(term, () => useAppStore.getState().settings.terminalRenderer)

    // Untrusted output: clipboard writes swallowed, cwd and prompt marks ignored.
    const oscs = [52, 7, 133].map((id) => term.parser.registerOscHandler(id, () => true))

    const syncReadOnly = (): void => {
      const view = optsRef.current.perm === 'view'
      term.options.disableStdin = view
      if (term.textarea) term.textarea.readOnly = view
    }
    syncReadOnly()

    // --- Font fit to the host grid (never a resize of the host pty) ---
    let overflow = false
    const fitFont = (): void => {
      if (container.clientWidth < 8 || container.clientHeight < 8) return
      const normal = normalFont()
      const cur = term.options.fontSize ?? normal
      const now = cellOf(term)
      if (!now) return
      const base = { w: (now.w * normal) / cur, h: (now.h * normal) / cur }
      const avail = { w: container.clientWidth - scrollBarWidth(term), h: container.clientHeight }
      const grid = { cols: term.cols, rows: term.rows }
      let font = fitGeometry(grid, avail, base, normal).fontSize
      if (term.options.fontSize !== font) term.options.fontSize = font
      // Cells round to device pixels: step down while the measured grid still overflows.
      for (let i = 0; i < 4 && font > FIT_MIN_FONT; i++) {
        const c = cellOf(term)
        if (!c || (grid.cols * c.w <= avail.w + 0.5 && grid.rows * c.h <= avail.h + 0.5)) break
        font -= 1
        term.options.fontSize = font
      }
      const c = cellOf(term)
      const over = !!c && (grid.cols * c.w > avail.w + 0.5 || grid.rows * c.h > avail.h + 0.5)
      if (over !== overflow) {
        overflow = over
        container.style.overflow = over ? 'auto' : ''
      }
      container.dataset.fitFont = String(font)
    }
    refitRef.current = fitFont

    // --- Host stream ---
    let pending = 0
    let paused = false
    const write = (data: string): void => {
      if (!data) return
      pending += data.length
      if (!paused && pending > SHARE_HIGH_WATER) {
        paused = true
        api.flow({ linkId, paneId, pause: true })
      }
      term.write(data, () => {
        pending -= data.length
        if (paused && pending < SHARE_LOW_WATER) {
          paused = false
          api.flow({ linkId, paneId, pause: false })
        }
      })
    }
    const resizeTo = (cols: number, rows: number): void => {
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
      fitFont()
    }
    const onItem = (item: ShareTermItem): void => {
      switch (item.t) {
        case 'replay':
          if (item.first) {
            term.reset()
            container.dataset.hostSize = `${item.cols}x${item.rows}`
            resizeTo(item.cols, item.rows)
          }
          write(item.data)
          if (item.last && !item.running && item.exitCode !== undefined) write(optsRef.current.exitLine(item.exitCode))
          return
        case 'out':
          write(item.data)
          return
        case 'fit':
          container.dataset.hostSize = `${item.cols}x${item.rows}`
          resizeTo(item.cols, item.rows)
          return
        case 'exit':
          write(optsRef.current.exitLine(item.code))
          return
      }
    }
    const offSink = registerShareTerm(linkId, paneId, onItem)
    api.sub(linkId, paneId)

    // --- Input ---
    const gate = new ShareInputGate()
    let lastByte = 'x'
    let pasting = false
    const send = (data: string): void => {
      const o = optsRef.current
      if (o.perm === 'view') return
      const verdict = gate.check(data, o.perm, { ...o.ctx(), lastByte })
      if (!verdict.ok) {
        if (!verdict.drop) o.onRefused(verdict.reason)
        return
      }
      if (o.lock) {
        // A lease held by the host or another guest: reports go silently, keys say why.
        if (!REPORTS_ONLY_RE.test(data)) o.onRefused(o.lock === 'host' ? 'host_typing' : 'other_typing')
        return
      }
      gate.commit(data)
      if (!REPORTS_ONLY_RE.test(data)) lastByte = data[data.length - 1]
      api.input({ linkId, paneId, data, ...(pasting ? { paste: true } : {}) })
    }
    const input = term.onData(send)
    const paste = (text: string): void => {
      pasting = true
      try {
        term.paste(text)
      } finally {
        pasting = false
      }
    }
    // A native paste (context menu, middle click) is one unit too.
    const onPasteCapture = (): void => {
      pasting = true
      setTimeout(() => {
        pasting = false
      }, 0)
    }
    container.addEventListener('paste', onPasteCapture, true)

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return true
      const key = e.key.toLowerCase()
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
        return true // ^C, judged by the gate
      }
      if (key === 'v') {
        e.preventDefault()
        if (optsRef.current.perm === 'view') return false
        // xterm's paste: CRLF normalized and the bracketed mode the stream itself set.
        void window.snApi.clipboard.readText().then((text) => {
          if (text) paste(text)
        })
        return false
      }
      // Ctrl+Enter inserts a newline in AI CLIs (ESC+CR), only with full control.
      if (key === 'enter' && e.ctrlKey && !e.shiftKey && optsRef.current.perm === 'full') {
        e.preventDefault()
        send('\x1b\r')
        return false
      }
      return true
    })

    controllerRef.current.focus = () => term.focus()
    const offFocus = useShareGuestStore.subscribe((s, prev) => {
      const r = s.focusReq
      if (r && r !== prev.focusReq && r.linkId === linkId && r.paneId === paneId) requestAnimationFrame(() => term.focus())
    })
    // A view that mounts after the request (first open) still takes it.
    const initial = useShareGuestStore.getState().focusReq
    if (initial && initial.linkId === linkId && initial.paneId === paneId) requestAnimationFrame(() => term.focus())

    let roRaf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(roRaf)
      roRaf = requestAnimationFrame(fitFont)
    })
    ro.observe(container)
    const offDisplay = window.snApi.system.onDisplayRecovered(() => rendererHandle.heal())

    return () => {
      cancelAnimationFrame(roRaf)
      ro.disconnect()
      offDisplay()
      offFocus()
      offSink()
      api.unsub(linkId, paneId)
      container.removeEventListener('paste', onPasteCapture, true)
      container.style.overflow = ''
      delete container.dataset.fitFont
      delete container.dataset.hostSize
      input.dispose()
      for (const o of oscs) o.dispose()
      rendererHandle.dispose()
      term.dispose()
      termRef.current = null
      refitRef.current = () => undefined
      controllerRef.current = { focus: () => undefined }
    }
    // One terminal per (link, pane); everything else is read through optsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, opts.linkId, opts.paneId])

  // Live theme and font: the palette swaps in place, the font refits to the host grid.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = buildXtermTheme(theme, customColors)
  }, [theme, customColors])
  useEffect(() => {
    refitRef.current()
  }, [fontSize])
  // A live permission change: view makes the helper textarea read-only at once.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const view = opts.perm === 'view'
    term.options.disableStdin = view
    if (term.textarea) term.textarea.readOnly = view
  }, [opts.perm])
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.unicode.activeVersion = opts.unicode11 ? '11' : '6'
    } catch {
      /* addon missing */
    }
  }, [opts.unicode11])

  return controllerRef.current
}
