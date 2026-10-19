import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { REVIEW_NOTE_MAX_BODY } from '@shared/review-notes'
import { useT } from '@/i18n'

/**
 * Inline editor of a review note (E7-FR-17): a textarea under the annotated
 * line (or above the diff for a file note). Ctrl+Enter saves, Esc cancels,
 * at most 4000 characters. Its keys never reach the panel (F7, Alt+arrows,
 * Esc closing the drawer) nor the console.
 */
export function NoteEditor({ label, initial = '', onSave, onCancel }: { label: string; initial?: string; onSave: (body: string) => void; onCancel: () => void }) {
  const t = useT()
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollIntoView({ block: 'nearest' })
  }, [])

  const save = (): void => {
    if (text.trim()) onSave(text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      save()
    }
  }

  return (
    <div className="mx-2 my-1 rounded-btn border border-accent-violet/50 bg-card p-2 font-sans text-xs" data-note-editor onKeyDown={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-text-secondary">
        <span className="font-medium text-text-primary">{label}</span>
        <span className="font-mono">{t('notes.charCount', { count: text.length, max: REVIEW_NOTE_MAX_BODY })}</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        maxLength={REVIEW_NOTE_MAX_BODY}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('notes.placeholder')}
        aria-label={label}
        className="block w-full resize-y rounded-btn border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/60"
        data-note-textarea
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-secondary">{t('notes.editorHint')}</span>
        <div className="flex gap-1.5">
          <button type="button" onClick={onCancel} className="rounded-btn border border-border px-2 py-0.5 text-text-primary hover:bg-bg-secondary" data-note-cancel>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!text.trim()}
            className="rounded-btn bg-accent-violet px-2 py-0.5 font-medium text-white hover:opacity-90 disabled:opacity-40"
            data-note-save
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
