/**
 * The workspace's notes on this phone (E3-FR-54, 55), opened from the "N
 * notes" badge: the pending ones in the order the batch prints them, each
 * with its `file:lines`, the "Outdated" tag when it applies and a delete
 * button. "Show sent" brings back the notes already sent. "Send N notes"
 * opens the send sheet (SendNotesSheet).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Send, Trash2 } from 'lucide-react'
import { Sheet } from '../Sheet'
import { closeNotesUi, openNotesUi, useChangesStore } from '../../lib/changes'
import { isSent, noteLines, pendingNotes, useNotesStore, type PhoneNote } from '../../lib/notesStore'
import { t } from '../../lib/i18n'

function NoteItem({ note, onRemove }: { note: PhoneNote; onRemove: (id: string) => void }): ReactNode {
  const ref = `${note.file}:${noteLines(note)}`
  return (
    <div data-notes-item={note.id} data-note-sent={isSent(note) ? 'true' : undefined} className="flex items-start gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span data-notes-ref className="min-w-0 break-all font-mono text-[11px] text-text-secondary">{ref}</span>
          {note.stale && (
            <span data-note-tag="stale" className="rounded-full bg-text-secondary/20 px-1.5 text-[10px] text-text-secondary">
              {t('notes.stale')}
            </span>
          )}
          {isSent(note) && (
            <span data-note-tag="sent" className="rounded-full bg-state-done/15 px-1.5 text-[10px] text-state-done">
              {t('notes.sentTag')}
            </span>
          )}
        </span>
        <span className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-text-primary">{note.comment}</span>
      </div>
      <button
        type="button"
        data-notes-remove={note.id}
        onClick={() => onRemove(note.id)}
        aria-label={t('notes.deleteNote', { ref })}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
      >
        <Trash2 size={16} />
      </button>
    </div>
  )
}

export function NotesList(): ReactNode {
  const workspaceId = useChangesStore((s) => s.workspaceId)
  const open = useChangesStore((s) => s.notesUi === 'list' && s.workspaceId != null)
  const notes = useNotesStore((s) => (workspaceId ? s.byWs[workspaceId] : undefined))
  const [showSent, setShowSent] = useState(false)

  useEffect(() => {
    if (workspaceId) useNotesStore.getState().ensure(workspaceId)
  }, [workspaceId])
  useEffect(() => {
    if (open) setShowSent(false)
  }, [open])

  const all = notes ?? []
  const pending = pendingNotes(all)
  const sent = all.filter(isSent).sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))
  const remove = (id: string): void => {
    if (workspaceId) useNotesStore.getState().remove(workspaceId, [id])
  }

  return (
    <Sheet open={open} onClose={closeNotesUi} title={t('notes.title')}>
      <div data-notes-list={workspaceId ?? ''} className="flex flex-col gap-3">
        {pending.length === 0 ? (
          <p data-notes-empty className="px-1 py-4 text-center text-sm text-text-secondary">{t('notes.empty')}</p>
        ) : (
          <div className="overflow-hidden rounded-card border border-border bg-bg-secondary">
            {pending.map((n) => (
              <NoteItem key={n.id} note={n} onRemove={remove} />
            ))}
          </div>
        )}
        {sent.length > 0 && (
          <button
            type="button"
            data-notes-show-sent
            aria-expanded={showSent}
            onClick={() => setShowSent((v) => !v)}
            className="self-center rounded-btn px-3 py-2 text-xs font-medium text-accent-violet active:bg-card"
          >
            {showSent ? t('notes.hideSent') : t('notes.showSent', { n: sent.length })}
          </button>
        )}
        {showSent && sent.length > 0 && (
          <div data-notes-sent className="overflow-hidden rounded-card border border-border bg-bg-secondary opacity-80">
            {sent.map((n) => (
              <NoteItem key={n.id} note={n} onRemove={remove} />
            ))}
          </div>
        )}
        <p className="px-1 text-center text-[11px] text-text-secondary">{t('notes.localOnly')}</p>
        <button
          type="button"
          data-notes-send
          disabled={pending.length === 0}
          onClick={() => openNotesUi('send')}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-btn bg-accent-violet text-sm font-semibold text-white active:opacity-90 disabled:opacity-50"
        >
          <Send size={16} />
          {pending.length === 1 ? t('notes.send1') : t('notes.send', { n: pending.length })}
        </button>
      </div>
    </Sheet>
  )
}
