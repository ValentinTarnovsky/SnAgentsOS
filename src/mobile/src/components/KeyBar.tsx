/**
 * Docked key bar for keys a soft keyboard lacks or sends unreliably: Esc, Tab,
 * a latching Ctrl, arrow keys (DECCKM-aware), Enter, Paste, and a keyboard
 * show/hide toggle.
 *
 * EVERY button calls preventDefault on pointerdown so tapping it never blurs the
 * hidden xterm textarea (which would dismiss the soft keyboard). Actions fire on
 * pointerdown for snappy, reliable touch response; the keyboard toggle drives
 * focus explicitly so preventDefault does not interfere.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  FileText,
  Keyboard,
} from 'lucide-react'
import { client } from '../lib/client'
import { getActiveTerm } from '../lib/terminalBus'
import { useRemoteStore } from '../lib/store'
import { t } from '../lib/i18n'

function sendArrow(dir: 'A' | 'B' | 'C' | 'D'): void {
  const term = getActiveTerm()
  // DECCKM: in application-cursor-keys mode send SS3 (ESC O x), else CSI (ESC [ x).
  const app = term?.modes.applicationCursorKeysMode ?? false
  client.sendInput(app ? `\x1bO${dir}` : `\x1b[${dir}`)
}

interface KeyProps {
  label?: string
  onDown: () => void
  active?: boolean
  children?: ReactNode
}

function Key({ label, onDown, active, children }: KeyProps): ReactNode {
  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault()
        onDown()
      }}
      className={clsx(
        'flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-btn border px-3 text-xs font-medium transition select-none',
        active
          ? 'border-accent-violet bg-accent-violet text-white'
          : 'border-border bg-bg-secondary text-text-primary active:bg-card',
      )}
    >
      {children ?? label}
    </button>
  )
}

export function KeyBar({
  onPaste,
  onSnippets,
}: {
  onPaste: () => void
  onSnippets: () => void
}): ReactNode {
  const ctrlLatch = useRemoteStore((s) => s.ctrlLatch)
  const setCtrlLatch = useRemoteStore((s) => s.setCtrlLatch)
  const snapshot = useRemoteStore((s) => s.snapshot)
  const keyButtons = snapshot?.keyButtons ?? []
  const [kbShown, setKbShown] = useState(false)

  const toggleKeyboard = (): void => {
    const term = getActiveTerm()
    if (!term) return
    if (kbShown) {
      term.blur()
      setKbShown(false)
    } else {
      term.focus()
      setKbShown(true)
    }
  }

  return (
    <div
      data-scrollable
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-card px-2 py-2"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 8px)' }}
    >
      <Key label={t('key.esc')} onDown={() => client.sendInput('\x1b')} />
      <Key label={t('key.tab')} onDown={() => client.sendInput('\t')} />
      <Key label={t('key.ctrl')} active={ctrlLatch} onDown={() => setCtrlLatch(!ctrlLatch)} />
      <Key onDown={() => sendArrow('D')}>
        <ChevronLeft size={18} />
      </Key>
      <Key onDown={() => sendArrow('A')}>
        <ChevronUp size={18} />
      </Key>
      <Key onDown={() => sendArrow('B')}>
        <ChevronDown size={18} />
      </Key>
      <Key onDown={() => sendArrow('C')}>
        <ChevronRight size={18} />
      </Key>
      <Key label={t('key.enter')} onDown={() => client.sendInput('\r')} />
      <Key label={t('key.shiftTab')} onDown={() => client.sendInput('\x1b[Z')} />
      <Key label={t('key.ctrlEnter')} onDown={() => client.sendInput('\x1b\r')} />
      {keyButtons.map((btn) => (
        <Key key={btn.id} label={btn.label} onDown={() => client.sendInput(btn.seq)} />
      ))}
      <Key onDown={onPaste}>
        <ClipboardPaste size={18} />
      </Key>
      <Key onDown={onSnippets}>
        <FileText size={18} />
      </Key>
      <Key active={kbShown} onDown={toggleKeyboard}>
        <Keyboard size={18} />
      </Key>
    </div>
  )
}
