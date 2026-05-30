import { useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

/** Pretty-print an Electron accelerator (Super shows as Win). */
function formatAccel(accel: string): string {
  if (!accel) return ''
  return accel
    .split('+')
    .map((p) => (p === 'Super' ? 'Win' : p))
    .join(' + ')
}

const KEY_MAP: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
}

/** Build an Electron accelerator from a keydown; requires ≥1 modifier. */
function buildAccel(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  const key = e.key
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Dead'].includes(key)) return null

  let main = ''
  if (key.length === 1) main = key.toUpperCase()
  else if (/^F\d{1,2}$/.test(key)) main = key
  else main = KEY_MAP[key] ?? ''

  if (!main || mods.length === 0) return null
  return [...mods, main].join('+')
}

export function HotkeyInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (accelerator: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const [recording, setRecording] = useState(false)

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return
          e.preventDefault()
          const accel = buildAccel(e)
          if (accel) {
            onChange(accel)
            setRecording(false)
          }
        }}
        className={cn(
          'h-9 min-w-[190px] rounded-btn border px-3 text-sm transition-colors',
          recording
            ? 'border-accent-violet bg-accent-violet/5 text-text-primary'
            : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {recording
          ? t('settings.hotkeyRecord')
          : value
            ? formatAccel(value)
            : t('settings.hotkeySet')}
      </button>
      {value && !disabled && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="rounded p-1.5 text-text-secondary transition-colors hover:bg-red-400/10 hover:text-red-400"
          title={t('settings.hotkeyClear')}
        >
          <X size={15} />
        </button>
      )}
    </div>
  )
}
