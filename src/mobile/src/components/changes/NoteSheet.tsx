/**
 * "Note on App.tsx:42" (E3-FR-54): a textarea of up to 4000 characters and a
 * "Up to line" stepper for a range inside the hunk. Opened by a tap on a
 * line number of a diff (new note) or on a note under its line (edit, with
 * Delete). Saving stores it on this phone only (notesStore); an edited note
 * goes back to pending.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Minus, Plus, Trash2 } from 'lucide-react'
import { Sheet } from '../Sheet'
import { store } from '../../lib/store'
import { NOTE_MAX_CHARS, useNotesStore, type PhoneNote } from '../../lib/notesStore'
import { baseName } from '../../lib/changes'
import { t } from '../../lib/i18n'

/** What the sheet edits: a new note on `line`, or an existing one. */
export interface NoteDraft {
  file: string
  line: number
  /** Text of the line now (kept to flag the note outdated later). */
  lineText?: string
  /** Highest line the range can reach (the end of the line's hunk). */
  maxLine: number
  note?: PhoneNote
}

export function NoteSheet({ workspaceId, draft, onClose }: { workspaceId: string; draft: NoteDraft | null; onClose: () => void }): ReactNode {
  const [text, setText] = useState('')
  const [until, setUntil] = useState(0)
  // Keep the content through the exit animation, after the parent cleared it.
  const last = useRef<NoteDraft | null>(null)
  if (draft) last.current = draft
  const shown = draft ?? last.current

  useEffect(() => {
    if (!draft) return
    setText(draft.note?.comment ?? '')
    setUntil(draft.note?.endLine ?? draft.line)
  }, [draft])

  if (!shown) return <Sheet open={false} onClose={onClose}>{null}</Sheet>
  const maxLine = Math.max(shown.line, shown.maxLine, shown.note?.endLine ?? 0)
  const canSave = text.trim().length > 0

  const save = (): void => {
    if (!draft || !canSave) return
    const notes = useNotesStore.getState()
    const endLine = until > draft.line ? until : undefined
    if (draft.note) {
      notes.edit(workspaceId, draft.note.id, { comment: text, ...(endLine ? { endLine } : {}) })
    } else if (!notes.add(workspaceId, { file: draft.file, line: draft.line, ...(endLine ? { endLine } : {}), ...(draft.lineText !== undefined ? { lineText: draft.lineText } : {}), comment: text })) {
      store.getState().setToast(t('notes.full'))
      return
    }
    onClose()
  }

  return (
    <Sheet open={draft != null} onClose={onClose} title={t('notes.sheetTitle', { file: baseName(shown.file), line: shown.line })}>
      <div data-note-sheet={`${shown.file}:${shown.line}`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <textarea
            data-note-text
            data-kb-input="note"
            value={text}
            maxLength={NOTE_MAX_CHARS}
            rows={5}
            placeholder={t('notes.placeholder')}
            aria-label={t('notes.placeholder')}
            onChange={(e) => setText(e.target.value.slice(0, NOTE_MAX_CHARS))}
            className="min-h-28 w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-base text-text-primary outline-none focus:border-accent-violet"
          />
          <span data-note-count className="self-end text-[11px] text-text-secondary">
            {text.length}/{NOTE_MAX_CHARS}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-text-primary">{t('notes.until')}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-note-until-less
              disabled={until <= shown.line}
              onClick={() => setUntil((u) => Math.max(shown.line, u - 1))}
              aria-label={t('notes.lessLine')}
              className="flex h-10 w-10 items-center justify-center rounded-btn border border-border text-text-primary active:bg-card disabled:opacity-40"
            >
              <Minus size={16} />
            </button>
            <span data-note-until className="w-14 text-center font-mono text-sm text-text-primary">
              {until}
            </span>
            <button
              type="button"
              data-note-until-more
              disabled={until >= maxLine}
              onClick={() => setUntil((u) => Math.min(maxLine, u + 1))}
              aria-label={t('notes.moreLine')}
              className="flex h-10 w-10 items-center justify-center rounded-btn border border-border text-text-primary active:bg-card disabled:opacity-40"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          {shown.note && (
            <button
              type="button"
              data-note-delete
              onClick={() => {
                if (shown.note) useNotesStore.getState().remove(workspaceId, [shown.note.id])
                onClose()
              }}
              className="flex h-12 items-center justify-center gap-1.5 rounded-btn border border-border px-4 text-sm font-medium text-state-error active:bg-card"
            >
              <Trash2 size={16} />
              {t('notes.delete')}
            </button>
          )}
          <button
            type="button"
            data-note-save
            disabled={!canSave}
            onClick={save}
            className="h-12 flex-1 rounded-btn bg-accent-violet text-sm font-semibold text-white active:opacity-90 disabled:opacity-50"
          >
            {t('notes.save')}
          </button>
        </div>
      </div>
    </Sheet>
  )
}
