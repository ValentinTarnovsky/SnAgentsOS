/**
 * Composer docked between the terminal and the KeyBar (E1-FR-23..31). A real
 * textarea, so dictation, the caret and (optionally) autocorrect work, which
 * xterm's hidden helper textarea cannot offer.
 *
 *  - Grows from 1 to 6 lines, then scrolls inside. 16px text for legibility,
 *    COMPOSER_MAX chars, a counter from COMPOSER_COUNTER_FROM.
 *  - Send: safePaste (E3-FR-05: sanitized, bracketed when the pane has it) + a
 *    separate `\r` frame. Slash commands in agent panes are typed key by key
 *    with visible progress.
 *  - Hold Send LONG_PRESS_MS: Insert, the text lands without Enter.
 *  - Working agent + empty field: the button becomes Stop (ESC).
 *  - Drafts per pane, debounced, restored when the pane is viewed again.
 *  - Paste key one-shot: after Send or Insert the pane goes back to Direct.
 *  - Mic (v2.2): dictation lands at the caret, never with Enter; Send ends it.
 *
 * Delivery rules live in lib/composerSend.ts; this file binds them to the WS
 * client, the live xterm and the store.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { clsx } from 'clsx'
import { SendHorizontal, Square } from 'lucide-react'
import { client } from '../lib/client'
import { selectInputMode, store, useRemoteStore } from '../lib/store'
import { getActiveTerm, getComposerHandle, setComposerHandle } from '../lib/terminalBus'
import { paneById } from '../lib/workspace'
import { clearDraft, createDraftWriter, loadDraft } from '../lib/drafts'
import {
  COMPOSER_COUNTER_FROM,
  COMPOSER_MAX,
  INSERT_VIBRATE_MS,
  LONG_PRESS_MS,
  STOP_SEQ,
  abortableSleep,
  insertAt,
  needsMultilineConfirm,
  sendComposer,
  shouldTypeSlash,
  type ComposerIo,
} from '../lib/composerSend'
import { pasteBracketed } from '../lib/safePaste'
import { appendRef } from '../lib/upload'
import { t } from '../lib/i18n'
import { ImageButton } from './UploadChip'
import { MicButton, VoiceInterim } from './MicButton'
import { spaced, stopDictation } from '../lib/voice'

/** 16px text on a 22px line: the 6-line cap is measured from these. */
const LINE_PX = 22
const MAX_LINES = 6
const PRESS_SLOP_PX = 10

/** E3-FR-05: the viewed pane's bracketed paste (claude/codex status, else the xterm's mode). */
function viewedBracketed(): boolean | undefined {
  const s = store.getState()
  const status = s.subscribedPaneId ? s.paneStatus[s.subscribedPaneId] : null
  return pasteBracketed(getActiveTerm()?.modes.bracketedPasteMode, status)
}

const io: ComposerIo = {
  isOpen: () => client.isOpen(),
  currentPaneId: () => store.getState().subscribedPaneId,
  bracketed: viewedBracketed,
  sendInput: (data) => client.sendInput(data),
  releaseLatch: () => {
    if (store.getState().ctrlLatch) store.getState().setCtrlLatch(false)
  },
  sleep: abortableSleep,
}

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* not supported (iOS) or blocked */
  }
}

/**
 * The ">>" chip (E1-FR-22): flip and persist the viewed pane's mode. Ending a
 * one-shot only drops it (the saved mode was Direct all along). With the soft
 * keyboard up, the focus moves to the new mode's field so it stays up.
 */
export function toggleInputMode(): void {
  const s = store.getState()
  const paneId = s.activePaneId
  if (!paneId) return
  const keyboardUp = s.kbOpen
  const next = selectInputMode(s) === 'composer' ? 'direct' : 'composer'
  flushSync(() => {
    if (s.composerOneShot === paneId) s.update({ composerOneShot: null })
    else s.setInputMode(paneId, next)
  })
  if (!keyboardUp) return
  if (next === 'composer') getComposerHandle()?.focus()
  else getActiveTerm()?.textarea?.focus({ preventScroll: true })
}

/**
 * The Paste key (E1-FR-31): open the composer focused. In Direct mode it opens
 * as a one-shot that returns to Direct after Send or Insert. Runs inside the
 * key's pointerup, so the synchronous focus can raise the iOS keyboard.
 */
export function openComposerForPaste(): void {
  const s = store.getState()
  const paneId = s.activePaneId
  if (!paneId) return
  if (selectInputMode(s) !== 'composer') flushSync(() => s.update({ composerOneShot: paneId }))
  getComposerHandle()?.focus()
}

type ButtonMode = 'send' | 'stop' | 'slash'

export function Composer(): ReactNode {
  const paneId = useRemoteStore((s) => s.activePaneId)
  const connected = useRemoteStore((s) => s.connected)
  const autocorrect = useRemoteStore((s) => s.composerAutocorrect)
  const working = useRemoteStore((s) => (s.activePaneId ? s.paneStatus[s.activePaneId]?.state === 'working' : false))
  const slashProgress = useRemoteStore((s) => s.slashProgress)
  const [text, setText] = useState('')
  const [confirm, setConfirm] = useState<{ enter: boolean } | null>(null)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  const paneRef = useRef(paneId)
  paneRef.current = paneId
  const pendingCaret = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const writer = useMemo(() => createDraftWriter(), [])

  // Restore the viewed pane's draft; leaving it writes any pending draft and
  // aborts a slash command still being typed (E1-FR-25, FR-28).
  useEffect(() => {
    setText(paneId ? (loadDraft(paneId)?.text ?? '') : '')
    setConfirm(null)
    return () => {
      writer.flush()
      abortRef.current?.abort()
    }
  }, [paneId, writer])

  // The socket dropping aborts slash typing too.
  useEffect(() => {
    if (!connected) abortRef.current?.abort()
  }, [connected])

  // A hidden page may never come back (iOS discards it): write the draft now.
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') writer.flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', writer.flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', writer.flush)
    }
  }, [writer])

  const change = (value: string): void => {
    const next = value.slice(0, COMPOSER_MAX)
    setText(next)
    if (confirm) setConfirm(null)
    if (paneRef.current) writer.schedule(paneRef.current, next)
  }

  // QuickCommandsSheet inserts at the caret instead of writing to the pty (FR-31).
  useEffect(() => {
    setComposerHandle({
      insert(snippet) {
        const el = ref.current
        const start = el ? el.selectionStart : textRef.current.length
        const end = el ? el.selectionEnd : start
        const { value, caret } = insertAt(textRef.current, snippet, start, end)
        // A full field leaves the text as is: no re-render would consume the
        // caret, and a stale one would jump on the next keystroke.
        if (value !== textRef.current) {
          pendingCaret.current = caret
          change(value)
        }
        el?.focus({ preventScroll: true })
      },
      focus() {
        ref.current?.focus({ preventScroll: true })
      },
      paneId: () => paneRef.current,
      append(snippet) {
        const value = appendRef(textRef.current, snippet, COMPOSER_MAX)
        if (value == null) return false
        if (value !== textRef.current) {
          pendingCaret.current = value.length
          change(value)
        }
        return true
      },
    })
    return () => setComposerHandle(null)
  })

  // Grow with the content up to 6 lines, then scroll inside (FR-23).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (pendingCaret.current != null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const chrome =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    const max = LINE_PX * MAX_LINES + chrome
    const needed = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    el.style.height = `${Math.min(needed, max)}px`
    el.style.overflowY = needed > max ? 'auto' : 'hidden'
  }, [text])

  // Dictated words go to the caret (or the end), spaced, without moving the focus.
  const dictated = (chunk: string): void => {
    const el = ref.current
    const current = textRef.current
    const start = el && document.activeElement === el ? el.selectionStart : current.length
    const end = el && document.activeElement === el ? el.selectionEnd : start
    const piece = spaced(current.slice(0, start), chunk)
    if (!piece) return
    const { value, caret } = insertAt(current, piece, start, end)
    if (value === current) return
    pendingCaret.current = caret
    change(value)
  }

  const run = async (enter: boolean, confirmed = false): Promise<void> => {
    const value = textRef.current
    const id = paneRef.current
    const s = store.getState()
    if (!id || !value.trim() || s.slashProgress || !client.isOpen()) return
    // What goes out is what the field shows: a dictation still running ends here.
    stopDictation('composer', true)
    const pane = s.snapshot ? paneById(s.snapshot, id) : null
    const slash = enter && shouldTypeSlash(value, pane?.type, s.paneStatus[id])
    if (!slash && !confirmed && needsMultilineConfirm(value, viewedBracketed())) {
      setConfirm({ enter })
      return
    }
    setConfirm(null)
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    if (slash) s.update({ slashProgress: { done: 0, total: Array.from(value.trim()).length } })
    let ok = false
    try {
      ok = await sendComposer(
        value,
        {
          enter,
          paneId: id,
          signal: ac.signal,
          slash,
          onProgress: (done, total) => store.getState().update({ slashProgress: { done, total } }),
        },
        io,
      )
    } finally {
      if (slash) store.getState().update({ slashProgress: null })
      if (abortRef.current === ac) abortRef.current = null
    }
    if (!ok) return
    clearDraft(id)
    if (paneRef.current === id) {
      writer.cancel()
      setText('')
    }
    if (store.getState().composerOneShot === id) store.getState().update({ composerOneShot: null })
  }

  const stop = (): void => {
    if (client.isOpen()) client.sendInput(STOP_SEQ)
  }

  const mode: ButtonMode = slashProgress ? 'slash' : working && !text.trim() ? 'stop' : 'send'
  const disabled = mode === 'slash' || !connected || (mode === 'send' && !text.trim())
  const primary = (): void => {
    if (disabled) return
    if (mode === 'stop') stop()
    else if (mode === 'send') void run(true)
  }

  // Tap = Send (or Stop); hold LONG_PRESS_MS without moving = Insert (FR-26).
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number } | null>(null)
  const cancelPress = (): void => {
    if (press.current?.timer != null) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancelPress, [])

  const label =
    mode === 'slash' && slashProgress
      ? t('composer.typing', { done: slashProgress.done, total: slashProgress.total })
      : mode === 'stop'
        ? t('composer.stop')
        : connected
          ? t('composer.send')
          : t('conn.sendOffline')

  return (
    <div data-composer className="shrink-0 border-t border-border bg-bg-secondary px-2 py-2">
      {confirm && (
        <div data-composer-confirm className="mb-2 flex items-center gap-2 rounded-btn border border-border bg-card px-3 py-2">
          <span className="min-w-0 flex-1 text-xs text-text-primary">{t('composer.multiline')}</span>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setConfirm(null)}
            className="h-9 shrink-0 rounded-btn border border-border px-3 text-xs font-medium text-text-secondary active:bg-bg-secondary"
          >
            {t('act.cancel')}
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void run(confirm.enter, true)}
            className="h-9 shrink-0 rounded-btn bg-accent-violet px-3 text-xs font-medium text-white"
          >
            {t('act.confirm')}
          </button>
        </div>
      )}
      <VoiceInterim owner="composer" />
      <div className="flex items-end gap-2">
        {/* E3-FR-06: only with an httpToken; the reference lands in this pane's draft. */}
        {paneId && <ImageButton paneId={paneId} origin="composer" />}
        <MicButton owner="composer" resetKey={paneId} onFinal={dictated} />
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={ref}
            data-kb-input="composer"
            data-scrollable
            value={text}
            rows={1}
            maxLength={COMPOSER_MAX}
            onChange={(e) => change(e.target.value)}
            placeholder={t('composer.placeholder')}
            aria-label={t('composer.label')}
            autoCorrect={autocorrect ? 'on' : 'off'}
            autoCapitalize={autocorrect ? 'sentences' : 'off'}
            spellCheck={autocorrect}
            enterKeyHint="enter"
            className="block w-full resize-none rounded-btn border border-border bg-bg-primary px-3 py-[9px] text-text-primary outline-none placeholder:text-text-secondary focus:border-accent-violet"
            style={{ fontSize: 16, lineHeight: `${LINE_PX}px` }}
          />
          {text.length >= COMPOSER_COUNTER_FROM && (
            <span
              data-composer-counter
              className={clsx(
                'pointer-events-none absolute -top-5 right-1 text-[11px] tabular-nums',
                text.length >= COMPOSER_MAX ? 'text-red-400' : 'text-text-secondary',
              )}
            >
              {text.length}/{COMPOSER_MAX}
            </span>
          )}
        </div>
        <button
          type="button"
          data-composer-send={mode}
          // aria-disabled, not disabled: a disabled button gets no pointerdown,
          // so tapping it would blur the textarea and drop the keyboard.
          aria-disabled={disabled}
          aria-label={label}
          aria-description={mode === 'send' ? t('composer.insertHint') : undefined}
          onPointerDown={(e) => {
            // Keep the focus (and the soft keyboard) in the textarea.
            e.preventDefault()
            if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return
            cancelPress()
            const p: { timer: ReturnType<typeof setTimeout> | null; x: number; y: number } = {
              timer: null,
              x: e.clientX,
              y: e.clientY,
            }
            if (mode === 'send') {
              p.timer = setTimeout(() => {
                p.timer = null
                press.current = null
                vibrate(INSERT_VIBRATE_MS)
                void run(false)
              }, LONG_PRESS_MS)
            }
            press.current = p
          }}
          onPointerMove={(e) => {
            const p = press.current
            if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) cancelPress()
          }}
          onPointerUp={() => {
            const p = press.current
            if (!p) return
            cancelPress()
            primary()
          }}
          onPointerCancel={cancelPress}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') cancelPress()
          }}
          // Keyboard or assistive-tech activation: a click with detail 0.
          onClick={(e) => {
            if (e.detail === 0) primary()
          }}
          onContextMenu={(e) => e.preventDefault()}
          className={clsx(
            'flex h-11 min-w-[44px] shrink-0 select-none items-center justify-center rounded-btn px-3 text-xs font-semibold tabular-nums transition [-webkit-touch-callout:none]',
            mode === 'stop' ? 'bg-red-500 text-white' : 'bg-accent-violet text-white',
            disabled && 'opacity-40',
          )}
        >
          {mode === 'slash' && slashProgress ? (
            `${slashProgress.done}/${slashProgress.total}`
          ) : mode === 'stop' ? (
            <Square size={16} fill="currentColor" />
          ) : (
            <SendHorizontal size={18} />
          )}
        </button>
      </div>
    </div>
  )
}
