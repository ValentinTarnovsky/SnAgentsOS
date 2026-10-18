/**
 * Docked key bar for keys a soft keyboard lacks or sends unreliably
 * (E1-FR-16..21). Three zones: the input-mode chip pinned left, a horizontally
 * scrolling row built from lib/keys.ts, and the keyboard toggle pinned right.
 *
 * Firing (lib/keyPress.ts): every key fires on pointerup, only if the finger
 * moved less than 10px and no pointercancel arrived, so swiping the bar never
 * sends a key (the scroller is touch-action: pan-x, the browser cancels the
 * pointer once it pans). Arrows, Bksp and Del auto-repeat while held. No
 * setPointerCapture: touch pointers are implicitly captured on iOS/Android.
 *
 * EVERY button calls preventDefault on pointerdown so tapping it never blurs
 * the focused input (which would dismiss the soft keyboard). The keyboard
 * toggle drives focus explicitly, so preventDefault does not interfere.
 *
 * The mode chip only renders once a parent passes onToggleMode (the composer
 * owns the direct/composer mode); until then the bar runs in 'direct'.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { clsx } from 'clsx'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Delete,
  Keyboard,
  Zap,
} from 'lucide-react'
import { client } from '../lib/client'
import { getActiveTerm } from '../lib/terminalBus'
import { store, useRemoteStore } from '../lib/store'
import { t } from '../lib/i18n'
import { createKeyPress, type PressHandlers } from '../lib/keyPress'
import { buildScrollKeys, resolveSeq, type KeyDef, type KeyIcon } from '../lib/keys'

export type InputMode = 'direct' | 'composer'

const ICONS: Record<KeyIcon, ReactNode> = {
  left: <ChevronLeft size={18} />,
  up: <ChevronUp size={18} />,
  down: <ChevronDown size={18} />,
  right: <ChevronRight size={18} />,
  backspace: <Delete size={18} />,
  paste: <ClipboardPaste size={18} />,
  quick: <Zap size={18} />,
}

/** Live presses, so a pane switch or a hidden tab can stop every repeat. */
const livePresses = new Set<PressHandlers>()

function cancelAllPresses(): void {
  for (const press of livePresses) press.cancel()
}

/**
 * Write to the subscribed pty. False when offline (the repeat stops and the
 * key does nothing). Also honours a boolean result from client.sendInput, the
 * socket-OPEN signal of E1-FR-14, when the client provides one.
 */
function sendSeq(seq: string): boolean {
  if (store.getState().banner) return false
  const sent: unknown = client.sendInput(seq)
  return sent !== false
}

/** The input field that owns the keyboard in the given mode. */
function modeField(mode: InputMode): HTMLElement | null {
  if (mode === 'direct') return getActiveTerm()?.textarea ?? null
  return document.querySelector<HTMLElement>('[data-kb-input="composer"]')
}

interface PressKeyProps {
  /** Runs on a qualifying tap and on each repeat; false stops the repeat. */
  onFire: () => boolean
  repeat?: boolean
  ariaLabel: string
  active?: boolean
  dimmed?: boolean
  className?: string
  children: ReactNode
}

function PressKey({ onFire, repeat = false, ariaLabel, active, dimmed, className, children }: PressKeyProps): ReactNode {
  const fireRef = useRef(onFire)
  fireRef.current = onFire
  const press = useMemo(() => createKeyPress(() => fireRef.current(), { repeat }), [repeat])

  useEffect(() => {
    livePresses.add(press)
    return () => {
      press.cancel()
      livePresses.delete(press)
    }
  }, [press])

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onPointerDown={(e) => {
        e.preventDefault()
        if (e.pointerType === 'mouse' && e.button !== 0) return
        press.down(e)
      }}
      onPointerMove={(e) => press.move(e)}
      onPointerUp={(e) => press.up(e)}
      onPointerCancel={() => press.cancel()}
      // A mouse is not implicitly captured: leaving the key must end the press.
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') press.cancel()
      }}
      // Keyboard or assistive-tech activation produces a click with detail 0
      // and no pointer events: fire once so the bar stays accessible.
      onClick={(e) => {
        if (e.detail === 0) fireRef.current()
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={clsx(
        'flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-btn border px-3 text-xs font-medium transition select-none [-webkit-touch-callout:none]',
        active
          ? 'border-accent-violet bg-accent-violet text-white'
          : 'border-border bg-bg-secondary text-text-primary active:bg-card',
        dimmed && 'opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function KeyBar({
  onPaste,
  onQuickCommands,
  inputMode = 'direct',
  onToggleMode,
}: {
  onPaste: () => void
  onQuickCommands: () => void
  inputMode?: InputMode
  onToggleMode?: () => void
}): ReactNode {
  const ctrlLatch = useRemoteStore((s) => s.ctrlLatch)
  const setCtrlLatch = useRemoteStore((s) => s.setCtrlLatch)
  const setToast = useRemoteStore((s) => s.setToast)
  const keyButtons = useRemoteStore((s) => s.snapshot?.keyButtons)
  const offline = useRemoteStore((s) => s.banner != null)
  const kbOpen = useRemoteStore((s) => s.kbOpen && s.kbFocus === inputMode)
  const keys = useMemo(() => buildScrollKeys(keyButtons ?? []), [keyButtons])
  const composer = inputMode === 'composer'

  // Switching panes stops any running repeat (E1-FR-17). A store subscription
  // runs synchronously inside the pane change, so no repeat tick can slip in
  // and write a key into the new pane before a post-render effect would run.
  useEffect(
    () =>
      useRemoteStore.subscribe((s, prev) => {
        if (s.activePaneId !== prev.activePaneId || s.subscribedPaneId !== prev.subscribedPaneId) cancelAllPresses()
      }),
    [],
  )

  // So does the tab going to the background (lock screen, app switch).
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') cancelAllPresses()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const fire = (def: KeyDef): boolean => {
    if (def.action === 'paste') {
      onPaste()
      return true
    }
    if (def.action === 'quickCommands') {
      onQuickCommands()
      return true
    }
    if (def.latch) {
      // Composer text never passes through term.onData, where the latch is
      // applied, so the latch is disabled there and explains why (E1-FR-18).
      if (composer) setToast(t('key.ctrlComposerHint'))
      else if (!offline) setCtrlLatch(!store.getState().ctrlLatch)
      return true
    }
    const seq = resolveSeq(def, getActiveTerm())
    if (seq == null || !sendSeq(seq)) return false
    if (def.chip && store.getState().ctrlLatch) setCtrlLatch(false)
    return true
  }

  // E1-FR-20: closed -> focus the mode's field; open -> drop the focus. A field
  // that kept the focus while the OS hid the keyboard is re-focused, which is
  // what makes the keyboard come back.
  const toggleKeyboard = (): boolean => {
    const field = modeField(inputMode)
    if (kbOpen) {
      field?.blur()
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
    } else if (field) {
      if (document.activeElement === field) field.blur()
      field.focus({ preventScroll: true })
    }
    return true
  }

  return (
    <div
      className="flex shrink-0 items-center border-t border-border bg-card py-2"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 8px)' }}
    >
      {onToggleMode && (
        <div className="shrink-0 pl-2">
          <PressKey
            ariaLabel={t('key.mode')}
            active={composer}
            onFire={() => {
              onToggleMode()
              return true
            }}
          >
            {'>>'}
          </PressKey>
        </div>
      )}
      <div
        data-scrollable
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-2"
        style={{ touchAction: 'pan-x' }}
      >
        {keys.map((def) => {
          const label = def.labelKey ? t(def.labelKey) : def.label
          return (
            <PressKey
              key={def.id}
              repeat={def.repeat}
              ariaLabel={def.ariaKey ? t(def.ariaKey) : (label ?? def.id)}
              active={def.latch ? ctrlLatch && !composer : undefined}
              dimmed={def.latch ? composer || offline : offline && def.seq != null}
              onFire={() => fire(def)}
            >
              {def.icon ? ICONS[def.icon] : label}
            </PressKey>
          )
        })}
      </div>
      <div className="shrink-0 border-l border-border pl-2 pr-2">
        <PressKey ariaLabel={t('key.keyboard')} active={kbOpen} onFire={toggleKeyboard}>
          <Keyboard size={18} />
        </PressKey>
      </div>
    </div>
  )
}
