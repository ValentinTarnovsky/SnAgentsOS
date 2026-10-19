/**
 * Builder for one custom KeyBar key (E2-FR-46). A label of up to 8
 * characters (blank takes a suggested one) and one of two modes:
 *   - Key: a letter, digit, named key or F1-F12 with Ctrl/Alt/Shift toggles,
 *     turned into bytes by keySeq() (Ctrl+Right = `\x1b[1;5C`);
 *   - Text: a literal with an optional Enter after it.
 * The escaped bytes are previewed live; Save stays disabled while the key has
 * nothing to send (empty text, or Ctrl+Enter, which has no sequence of its
 * own and points to the Text mode). Lives inside a Sheet, so its fields
 * unmount when it closes.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Sheet } from './Sheet'
import { PrimaryButton } from './InfoScreen'
import { t, type MobileMessageKey } from '../lib/i18n'
import {
  customKeySeq,
  DIGIT_KEYS,
  escapeSeq,
  FUNCTION_KEYS,
  LETTER_KEYS,
  MAX_CUSTOM_LABEL,
  MAX_CUSTOM_TEXT,
  NAMED_KEYS,
  newCustomKeyId,
  suggestLabel,
  type CustomKey,
  type CustomKeySpec,
  type KeyMods,
  type NamedKey,
} from '../lib/keys'

/** The on/off pill used by the builder and the layout list. */
export function SwitchPill({ on }: { on: boolean }): ReactNode {
  return (
    <span className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', on ? 'bg-accent-violet' : 'bg-border')}>
      <span
        className={clsx(
          'absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
          on ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </span>
  )
}

const NAMED_LABEL: Record<NamedKey, MobileMessageKey> = {
  enter: 'custom.k.enter',
  tab: 'custom.k.tab',
  esc: 'custom.k.esc',
  backspace: 'custom.k.backspace',
  delete: 'custom.k.delete',
  up: 'custom.k.up',
  down: 'custom.k.down',
  left: 'custom.k.left',
  right: 'custom.k.right',
  home: 'custom.k.home',
  end: 'custom.k.end',
  pageUp: 'custom.k.pageUp',
  pageDown: 'custom.k.pageDown',
  space: 'custom.k.space',
}

const MODS: readonly (keyof KeyMods)[] = ['ctrl', 'alt', 'shift']
const MOD_LABEL: Record<keyof KeyMods, MobileMessageKey> = { ctrl: 'custom.ctrl', alt: 'custom.alt', shift: 'custom.shift' }

type Mode = CustomKey['mode']

interface Draft extends KeyMods {
  label: string
  mode: Mode
  key: string
  text: string
  enter: boolean
}

const EMPTY_DRAFT: Draft = { label: '', mode: 'key', key: 'right', ctrl: false, alt: false, shift: false, text: '', enter: false }

function draftOf(key: CustomKey | null): Draft {
  if (!key) return EMPTY_DRAFT
  if (key.mode === 'key') return { ...EMPTY_DRAFT, label: key.label, mode: 'key', key: key.key, ctrl: key.ctrl, alt: key.alt, shift: key.shift }
  return { ...EMPTY_DRAFT, label: key.label, mode: 'text', text: key.text, enter: key.enter }
}

/** The key the draft describes, minus the id and label. */
function specOf(d: Draft): CustomKeySpec {
  return d.mode === 'key'
    ? { mode: 'key', key: d.key, ctrl: d.ctrl, alt: d.alt, shift: d.shift }
    : { mode: 'text', text: d.text, enter: d.enter }
}

const segment = (active: boolean): string =>
  clsx(
    'h-11 flex-1 rounded-btn border text-sm font-medium transition',
    active ? 'border-accent-violet bg-accent-violet text-white' : 'border-border bg-bg-secondary text-text-primary active:bg-card',
  )

const fieldClass =
  'w-full rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet'

export function CustomKeySheet({
  open,
  initial,
  takenIds,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  /** The key being edited, or null for a new one. */
  initial: CustomKey | null
  /** Ids already in the layout, so a new key never collides. */
  takenIds: readonly string[]
  onClose: () => void
  onSave: (key: CustomKey) => void
  onDelete: (id: string) => void
}): ReactNode {
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial))

  useEffect(() => {
    if (open) setDraft(draftOf(initial))
  }, [open, initial])

  const patch = (p: Partial<Draft>): void => setDraft((d) => ({ ...d, ...p }))
  const spec = specOf(draft)
  const seq = customKeySeq(spec)
  const suggested = suggestLabel(spec)
  const ctrlEnter = draft.mode === 'key' && draft.key === 'enter' && draft.ctrl
  const label = draft.label.trim() || suggested
  const canSave = seq != null && label.length > 0

  const submit = (): void => {
    if (!canSave) return
    onSave({ ...spec, id: initial?.id ?? newCustomKeyId(takenIds), label })
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={t(initial ? 'custom.titleEdit' : 'custom.titleNew')}>
      <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="custom-key-label">
        {t('custom.label')}
      </label>
      <input
        id="custom-key-label"
        data-custom-label
        value={draft.label}
        maxLength={MAX_CUSTOM_LABEL}
        placeholder={suggested}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => patch({ label: [...e.target.value].slice(0, MAX_CUSTOM_LABEL).join('') })}
        className={clsx(fieldClass, 'mb-1')}
      />
      <p className="mb-4 text-[11px] text-text-secondary">
        {t('custom.labelHint', { n: MAX_CUSTOM_LABEL, suggested: suggested || '-' })}
      </p>

      <span className="mb-1 block text-xs font-medium text-text-secondary">{t('custom.mode')}</span>
      <div className="mb-4 flex gap-2" role="group" aria-label={t('custom.mode')}>
        {(['key', 'text'] as const).map((m) => (
          <button
            key={m}
            type="button"
            data-custom-mode={m}
            aria-pressed={draft.mode === m}
            onClick={() => patch({ mode: m })}
            className={segment(draft.mode === m)}
          >
            {t(m === 'key' ? 'custom.modeKey' : 'custom.modeText')}
          </button>
        ))}
      </div>

      {draft.mode === 'key' ? (
        <>
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="custom-key-key">
            {t('custom.key')}
          </label>
          <select
            id="custom-key-key"
            data-custom-key
            value={draft.key}
            onChange={(e) => patch({ key: e.target.value })}
            className={clsx(fieldClass, 'mb-4 h-11')}
          >
            <optgroup label={t('custom.groupKeys')}>
              {NAMED_KEYS.map((k) => (
                <option key={k} value={k}>
                  {t(NAMED_LABEL[k])}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('custom.groupLetters')}>
              {LETTER_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k.toUpperCase()}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('custom.groupDigits')}>
              {DIGIT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('custom.groupFn')}>
              {FUNCTION_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k.toUpperCase()}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="mb-1 block text-xs font-medium text-text-secondary">{t('custom.mods')}</span>
          <div className="mb-4 flex gap-2" role="group" aria-label={t('custom.mods')}>
            {MODS.map((mod) => (
              <button
                key={mod}
                type="button"
                data-custom-mod={mod}
                aria-pressed={draft[mod]}
                onClick={() => patch({ [mod]: !draft[mod] } as Partial<Draft>)}
                className={segment(draft[mod])}
              >
                {t(MOD_LABEL[mod])}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="custom-key-text">
            {t('custom.text')}
          </label>
          <input
            id="custom-key-text"
            data-custom-text
            value={draft.text}
            maxLength={MAX_CUSTOM_TEXT}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => patch({ text: e.target.value })}
            className={clsx(fieldClass, 'mb-2 font-mono')}
          />
          <button
            type="button"
            role="switch"
            aria-checked={draft.enter}
            data-custom-enter
            onClick={() => patch({ enter: !draft.enter })}
            className="mb-4 flex min-h-12 w-full items-center gap-3 rounded-card border border-border bg-bg-secondary px-4 py-3 text-left active:bg-card"
          >
            <span className="min-w-0 flex-1 text-sm text-text-primary">{t('custom.enter')}</span>
            <SwitchPill on={draft.enter} />
          </button>
        </>
      )}

      <div className="mb-4 rounded-card border border-border bg-card px-3 py-2">
        <span className="block text-[11px] text-text-secondary">{t('custom.preview')}</span>
        <code data-custom-preview className="block break-all font-mono text-sm text-text-primary">
          {seq != null ? escapeSeq(seq) : t(ctrlEnter ? 'custom.noSeq' : 'custom.empty')}
        </code>
      </div>

      <PrimaryButton onClick={submit} disabled={!canSave}>
        {t('act.save')}
      </PrimaryButton>
      {initial && (
        <button
          type="button"
          data-custom-delete
          onClick={() => {
            onDelete(initial.id)
            onClose()
          }}
          className="mt-2 h-12 w-full rounded-btn border border-border bg-bg-secondary text-sm font-medium text-red-500 active:bg-card"
        >
          {t('custom.delete')}
        </button>
      )}
    </Sheet>
  )
}
