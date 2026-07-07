/**
 * Single-input rename sheet, reused for console renaming. Save is disabled on
 * empty/whitespace-only text so a blank title never silently hangs the ctl
 * request (the zod schema requires title.min(1); store.renamePane no-ops on a
 * whitespace-only title). Lives inside a Sheet, so it unmounts when closed and
 * never leaves a second focusable field on the live screen.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Sheet } from './Sheet'
import { PrimaryButton } from './InfoScreen'
import { t } from '../lib/i18n'

export function RenameSheet({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean
  initial: string
  onClose: () => void
  onSave: (title: string) => void
}): ReactNode {
  const [value, setValue] = useState(initial)

  useEffect(() => {
    if (open) setValue(initial)
  }, [open, initial])

  const submit = (): void => {
    const v = value.trim()
    if (!v) return
    onSave(v)
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('act.rename')}>
      <label className="mb-2 block text-xs font-medium text-text-secondary">{t('rename.label')}</label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="mb-4 w-full rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet"
      />
      <PrimaryButton onClick={submit} disabled={value.trim().length === 0}>
        {t('act.save')}
      </PrimaryButton>
    </Sheet>
  )
}
