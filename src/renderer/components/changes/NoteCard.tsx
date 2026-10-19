import { Check, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { ReviewNote } from '@shared/review-notes'
import { useLang, useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { lastChangeTime } from '@/lib/gitChip'

/** "Line 40", "Lines 40-52" or "File" for a note's anchor. */
export function noteAnchorLabel(t: ReturnType<typeof useT>, n: Pick<ReviewNote, 'line' | 'startLine'>): string {
  if (!n.line) return t('notes.file')
  if (n.startLine && n.startLine < n.line) return t('notes.lines', { start: n.startLine, end: n.line })
  return t('notes.line', { line: n.line })
}

/**
 * A saved review note under its line (E7-FR-17, 18, 20): anchor, tags
 * ("sent hh:mm", "outdated", "resolved") and Edit / Delete / Resolve. A
 * resolved note collapses to one line and leaves the next batch.
 */
export function NoteCard({
  note,
  stale,
  showAnchor,
  onEdit,
  onDelete,
  onToggleResolve,
}: {
  note: ReviewNote
  stale: boolean
  /** Notes shown above the diff (file notes, lines no longer in it) name their line. */
  showAnchor?: boolean
  onEdit: () => void
  onDelete: () => void
  onToggleResolve: () => void
}) {
  const t = useT()
  const lang = useLang()
  const resolved = note.resolvedAt !== undefined
  // A range always names its lines: its card sits under the last one.
  const anchor = showAnchor || (!!note.startLine && note.startLine < note.line)
  const tags = (
    <>
      {note.sentAt !== undefined && (
        <span className="rounded-full bg-accent-violet/15 px-1.5 text-[10px] text-accent-violet" data-note-tag="sent">
          {t('notes.tag.sent', { time: lastChangeTime(note.sentAt, lang) })}
        </span>
      )}
      {stale && (
        <span className="rounded-full bg-state-action/15 px-1.5 text-[10px] text-state-action" data-note-tag="stale">
          {t('notes.tag.stale')}
        </span>
      )}
      {resolved && (
        <span className="rounded-full bg-bg-secondary px-1.5 text-[10px] text-text-secondary" data-note-tag="resolved">
          {t('notes.tag.resolved')}
        </span>
      )}
    </>
  )
  const btn = 'rounded-btn p-0.5 text-text-secondary hover:bg-bg-secondary hover:text-text-primary'

  if (resolved) {
    return (
      <div className="mx-2 my-0.5 flex items-center gap-2 rounded-btn border border-border/60 bg-card/60 px-2 py-0.5 font-sans text-[11px] text-text-secondary" data-note-card={note.id} data-note-resolved>
        {anchor && <span className="shrink-0 font-medium">{noteAnchorLabel(t, note)}</span>}
        <span className="min-w-0 flex-1 truncate">{note.body.split(/\r?\n/)[0]}</span>
        {tags}
        <button type="button" onClick={onToggleResolve} className={btn} aria-label={t('notes.reopen')} title={t('notes.reopen')} data-note-reopen>
          <RotateCcw size={12} />
        </button>
        <button type="button" onClick={onDelete} className={btn} aria-label={t('notes.delete')} title={t('notes.delete')} data-note-delete>
          <Trash2 size={12} />
        </button>
      </div>
    )
  }

  return (
    <div className={cn('mx-2 my-1 rounded-btn border bg-card px-2 py-1.5 font-sans text-xs', stale ? 'border-state-action/40' : 'border-border')} data-note-card={note.id}>
      <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
        {anchor && <span className="font-medium text-text-primary">{noteAnchorLabel(t, note)}</span>}
        {tags}
        <span className="flex-1" />
        <button type="button" onClick={onEdit} className={btn} aria-label={t('notes.edit')} title={t('notes.edit')} data-note-edit>
          <Pencil size={12} />
        </button>
        <button type="button" onClick={onDelete} className={btn} aria-label={t('notes.delete')} title={t('notes.delete')} data-note-delete>
          <Trash2 size={12} />
        </button>
        <button type="button" onClick={onToggleResolve} className={btn} aria-label={t('notes.resolve')} title={t('notes.resolve')} data-note-resolve>
          <Check size={12} />
        </button>
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-text-primary" data-note-body>
        {note.body}
      </p>
    </div>
  )
}
