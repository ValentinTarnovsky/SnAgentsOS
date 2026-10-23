import type { ReactNode } from 'react'
import type { ShareFilesRight, ShareNotesRight, ShareRights } from '@shared/types'
import { SHARE_FILES_RIGHTS, SHARE_NOTES_RIGHTS } from '@shared/shareRights'
import { useT, type MessageKey } from '@/i18n'
import { Toggle } from '@/components/settings/ui'
import { cn } from '@/lib/cn'

const NOTES_KEY: Record<ShareNotesRight, MessageKey> = {
  off: 'shareHost.rights.notesOff',
  read: 'shareHost.rights.notesRead',
  write: 'shareHost.rights.notesWrite',
}

const FILES_KEY: Record<ShareFilesRight, MessageKey> = {
  off: 'shareHost.rights.filesOff',
  read: 'shareHost.rights.filesRead',
}

const SWITCHES: ReadonlyArray<{ key: 'consoles' | 'chat' | 'changes'; label: MessageKey; hint: MessageKey }> = [
  { key: 'consoles', label: 'shareHost.rights.consoles', hint: 'shareHost.rights.consolesHint' },
  { key: 'chat', label: 'shareHost.rights.chat', hint: 'shareHost.rights.chatHint' },
  { key: 'changes', label: 'shareHost.rights.changes', hint: 'shareHost.rights.changesHint' },
]

const selectCls =
  'rounded-btn border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent-violet/60 disabled:cursor-not-allowed disabled:opacity-50'

interface ShareRightsEditorProps {
  value: ShareRights
  onChange: (rights: ShareRights) => void
  disabled?: boolean
  /** The guest runs an older SnAgentsOS (share protocol v1): its notes never write and it has no Files. */
  legacy?: boolean
  /** No hints and tighter rows: the join prompt and the Settings cards. */
  compact?: boolean
  className?: string
}

/**
 * What a guest may use besides the terminal (app 2.6.0): three switches
 * (consoles, chat, changes), notes (off / read / read and write) and files
 * (off / read only). Controlled and stateless: the Share dialog, the join
 * prompt and Settings > Sharing (per share and per guest) each own the value.
 * Only a workspace share has rights, so callers never render it for a console.
 * Each row carries data-share-right="<key>" for tests.
 */
export function ShareRightsEditor({ value, onChange, disabled, legacy, compact, className }: ShareRightsEditorProps) {
  const t = useT()
  const set = (patch: Partial<ShareRights>): void => onChange({ ...value, ...patch })
  // A v1 guest gets notes read-only and no Files whatever is stored: show what it really gets.
  const notes: ShareNotesRight = legacy && value.notes === 'write' ? 'read' : value.notes
  const files: ShareFilesRight = legacy ? 'off' : value.files

  const row = (right: keyof ShareRights, label: MessageKey, hint: MessageKey, control: ReactNode): ReactNode => (
    <div data-share-right={right} className={cn('flex items-center justify-between gap-3', compact ? 'py-0.5' : 'py-2')}>
      <div className="min-w-0">
        <span className={cn('block text-text-primary', compact ? 'text-xs' : 'text-sm')}>{t(label)}</span>
        {!compact && <span className="block text-xs text-text-secondary">{t(hint)}</span>}
      </div>
      {control}
    </div>
  )

  return (
    <div data-share-rights role="group" aria-label={t('shareHost.rights.title')} className={cn('space-y-1.5', className)}>
      <div className={cn(!compact && 'divide-y divide-border rounded-btn border border-border px-3')}>
        {SWITCHES.map((s) =>
          row(s.key, s.label, s.hint, <Toggle ariaLabel={t(s.label)} checked={value[s.key]} disabled={disabled} onChange={(on) => set({ [s.key]: on })} />),
        )}
        {row(
          'notes',
          'shareHost.rights.notes',
          'shareHost.rights.notesHint',
          <select
            aria-label={t('shareHost.rights.notes')}
            disabled={disabled}
            value={notes}
            onChange={(e) => set({ notes: e.target.value as ShareNotesRight })}
            className={selectCls}
          >
            {SHARE_NOTES_RIGHTS.map((n) => (
              <option key={n} value={n} disabled={legacy && n === 'write'}>
                {t(NOTES_KEY[n])}
              </option>
            ))}
          </select>,
        )}
        {row(
          'files',
          'shareHost.rights.files',
          'shareHost.rights.filesHint',
          <select
            aria-label={t('shareHost.rights.files')}
            disabled={disabled || legacy}
            value={files}
            onChange={(e) => set({ files: e.target.value as ShareFilesRight })}
            className={selectCls}
          >
            {SHARE_FILES_RIGHTS.map((f) => (
              <option key={f} value={f}>
                {t(FILES_KEY[f])}
              </option>
            ))}
          </select>,
        )}
      </div>
      {legacy && (
        <p data-share-rights-legacy className="text-[11px] leading-relaxed text-amber-300">
          {t('shareHost.rights.legacy')}
        </p>
      )}
    </div>
  )
}
