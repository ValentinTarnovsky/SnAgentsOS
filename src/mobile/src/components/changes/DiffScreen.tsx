/**
 * One file's unified diff (E3-FR-53, 54), pushed over Changes. Page 0 comes
 * first (gitReq op:'diff'); the next page is asked for once the reader gets
 * to 80% of the scroll, and a page with another `diffRev` restarts the read at
 * page 0 (the file changed). Green and red rows with their +/- prefix, the new
 * line number (the old one on a deleted line), hunk headers that stick to the
 * top while scrolling, wrapped long lines and "Next file" at the end. A file in
 * conflict shows its working tree diff with the markers.
 *
 * A tap on the number of an added or context line opens the note sheet
 * (NoteSheet) for that line; the notes show under their line, and the
 * outdated ones (the line changed or left the diff) on top with the line they
 * were written on. A binary file, a diff main found too large and a file
 * with no changes left each get their own message.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { clsx } from 'clsx'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { GitArea } from '@shared/git-types'
import type { RemoteGitDiffPage } from '@shared/remote-protocol'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { NotesBadge } from './NotesBadge'
import { NoteSheet, type NoteDraft } from './NoteSheet'
import { client } from '../../lib/client'
import {
  applyDiffPage,
  baseName,
  closeDiff,
  diffRows,
  diffTargetOf,
  emptyDiffLoad,
  gitOutcome,
  linePrefix,
  newSideLines,
  nextFile,
  openDiff,
  reloadChanges,
  shouldPrefetch,
  statusErrorKey,
  useChangesStore,
  type DiffLoad,
  type DiffRow,
  type DiffTarget,
} from '../../lib/changes'
import { isSent, noteLines, useNotesStore, type PhoneNote } from '../../lib/notesStore'
import { t, type MobileMessageKey } from '../../lib/i18n'

type Status = 'loading' | 'ok' | 'noReply' | 'gone' | 'error' | 'unstable'

const AREA_KEY: Record<GitArea, MobileMessageKey> = {
  staged: 'diff.staged',
  unstaged: 'diff.worktree',
  untracked: 'changes.section.untracked',
  conflict: 'changes.section.conflict',
}

function NoteCard({ note, onEdit, original }: { note: PhoneNote; onEdit: (n: PhoneNote) => void; original?: boolean }): ReactNode {
  return (
    <button
      type="button"
      data-note-card={note.id}
      data-note-stale={note.stale ? 'true' : undefined}
      onClick={() => onEdit(note)}
      className={clsx(
        'mx-3 my-1 flex w-[calc(100%-1.5rem)] flex-col gap-1 rounded-btn border bg-card px-3 py-2 text-left',
        note.stale ? 'border-border opacity-70' : 'border-accent-violet/50',
      )}
    >
      <span className="flex items-center gap-2 font-mono text-[11px] text-text-secondary">
        <span>L{noteLines(note)}</span>
        {note.stale && (
          <span data-note-tag="stale" className="rounded-full bg-text-secondary/20 px-1.5 font-sans text-[10px] text-text-secondary">
            {t('notes.stale')}
          </span>
        )}
      </span>
      {original && note.lineText !== undefined && (
        <span className="flex flex-col gap-0.5">
          <span className="text-[10px] text-text-secondary">{t('notes.wasLine', { line: note.line })}</span>
          <span data-note-original className="whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary line-through">
            {note.lineText || ' '}
          </span>
        </span>
      )}
      <span className="line-clamp-4 whitespace-pre-wrap break-words text-xs text-text-primary">{note.comment}</span>
    </button>
  )
}

function LineRow({ row, noteable, onNote }: { row: Extract<DiffRow, { kind: 'line' }>; noteable: boolean; onNote: (row: Extract<DiffRow, { kind: 'line' }>) => void }): ReactNode {
  const { line } = row
  const bg = line.kind === 'add' ? 'bg-ansi-green/15' : line.kind === 'del' ? 'bg-ansi-red/15' : ''
  const sign = line.kind === 'add' ? 'text-ansi-green' : line.kind === 'del' ? 'text-ansi-red' : 'text-text-secondary'
  const numberClass = 'w-11 shrink-0 select-none pr-1.5 text-right text-text-secondary/80'
  return (
    <div data-diff-line={row.no ?? ''} data-kind={line.kind} className={clsx('flex min-h-[20px] font-mono text-[12px] leading-[20px]', bg)}>
      {noteable && row.noteLine !== undefined ? (
        <button
          type="button"
          data-note-line={row.noteLine}
          onClick={() => onNote(row)}
          aria-label={t('diff.addNote', { line: row.noteLine })}
          className={clsx(numberClass, 'active:bg-accent-violet/30')}
        >
          {row.no}
        </button>
      ) : (
        <span className={numberClass}>{row.no ?? ''}</span>
      )}
      <span className={clsx('w-4 shrink-0 select-none text-center', sign)}>{line.kind === 'meta' ? '' : linePrefix(line.kind)}</span>
      <span className={clsx('min-w-0 flex-1 whitespace-pre-wrap break-all pr-3', line.kind === 'meta' ? 'italic text-text-secondary' : 'text-text-primary')}>
        {line.text || ' '}
      </span>
    </div>
  )
}

/** The screen body: reads the diff page by page and renders it (tests mount it inside DiffScreen). */
export function DiffBody({ workspaceId, target, scrollRef }: { workspaceId: string; target: DiffTarget; scrollRef: RefObject<HTMLDivElement | null> }): ReactNode {
  const [load, setLoad] = useState<DiffLoad>(() => emptyDiffLoad())
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const busy = useRef(false)
  const alive = useRef(true)
  const files = useChangesStore((s) => s.files)
  const notes = useNotesStore((s) => s.byWs[workspaceId])

  useEffect(() => {
    alive.current = true
    useNotesStore.getState().ensure(workspaceId)
    return () => {
      alive.current = false
    }
  }, [workspaceId])

  const fetchPage = useCallback(
    async (page: number): Promise<void> => {
      if (busy.current) return
      busy.current = true
      setStatus('loading')
      let next = page
      try {
        // A restart (another diffRev) asks for page 0 again right away.
        for (;;) {
          const res = await client.requestGit({ workspaceId, op: 'diff', path: target.path, ...(target.staged ? { staged: true } : {}), page: next })
          if (!alive.current) return
          const out = gitOutcome<RemoteGitDiffPage>(res)
          if (out.kind === 'noReply') {
            setStatus('noReply')
            return
          }
          if (out.kind === 'error') {
            setError(out.error)
            setStatus(out.error === 'not_found' ? 'gone' : 'error')
            return
          }
          const step = applyDiffPage(loadRef.current, next, out.data, out.done)
          loadRef.current = step.load
          setLoad(step.load)
          if (step.restart) {
            next = 0
            continue
          }
          setStatus(step.unstable ? 'unstable' : 'ok')
          return
        }
      } finally {
        busy.current = false
      }
    },
    [workspaceId, target.path, target.staged],
  )

  useEffect(() => {
    void fetchPage(0)
  }, [fetchPage])

  // FR-53: the next page once the reader is at 80% (or when the page does not fill the screen).
  const maybeMore = useCallback(() => {
    const el = scrollRef.current
    const l = loadRef.current
    if (!el || busy.current || l.done || !l.head) return
    if (shouldPrefetch(el.scrollTop, el.clientHeight, el.scrollHeight)) void fetchPage(l.nextPage)
  }, [fetchPage, scrollRef])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', maybeMore, { passive: true })
    return () => el.removeEventListener('scroll', maybeMore)
  }, [maybeMore, scrollRef])

  useEffect(() => {
    if (status !== 'ok') return
    // After the new rows are laid out (a timer, not rAF: it also runs while the page is hidden).
    const id = setTimeout(maybeMore, 30)
    return () => clearTimeout(id)
  }, [load, status, maybeMore])

  // FR-54: notes against the lines read so far ("Outdated" once the line changed or left).
  const textDiff = !!load.head && !load.head.binary && !load.head.tooLarge
  useEffect(() => {
    if (!textDiff) return
    useNotesStore.getState().refreshStale(workspaceId, target.path, newSideLines(load.hunks), load.done)
  }, [textDiff, load, workspaceId, target.path])

  const rows = diffRows(load.hunks)
  const fileNotes = (notes ?? []).filter((n) => n.file === target.path && !isSent(n))
  const stale = fileNotes.filter((n) => n.stale)
  const byLine = new Map<number, PhoneNote[]>()
  for (const n of fileNotes) {
    if (n.stale) continue
    const at = byLine.get(n.line) ?? []
    at.push(n)
    byLine.set(n.line, at)
  }
  // A conflict diff is the raw working tree with markers: it takes no notes (as on the desktop).
  const noteable = textDiff && target.area !== 'conflict'
  const lineTexts = textDiff ? newSideLines(load.hunks) : null
  const next = nextFile(files, target)

  const editNote = (n: PhoneNote): void => {
    const row = rows.find((r) => r.kind === 'line' && r.noteLine === n.line)
    setDraft({ file: n.file, line: n.line, maxLine: row && row.kind === 'line' ? row.hunkEnd : n.endLine ?? n.line, note: n })
  }

  return (
    <div data-diff-body={target.path} data-diff-status={status} data-diff-pages={load.nextPage} data-diff-done={load.done} className="flex flex-col pb-4">
      <div className="flex flex-col gap-0.5 border-b border-border px-4 py-3">
        <span data-diff-path className="break-all font-mono text-xs text-text-primary">{target.path}</span>
        <span className="text-[11px] text-text-secondary">
          {t(AREA_KEY[target.area])}
          {target.oldPath && ` · ${t('changes.renamedFrom', { old: target.oldPath })}`}
        </span>
      </div>

      {stale.length > 0 && (
        <div data-diff-stale className="border-b border-border py-1">
          {stale.map((n) => (
            <NoteCard key={n.id} note={n} onEdit={editNote} original />
          ))}
        </div>
      )}

      {status === 'gone' ? (
        <div data-diff-gone className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <p className="text-sm text-text-primary">{t('diff.gone')}</p>
          <button
            type="button"
            data-diff-back
            onClick={() => {
              closeDiff()
              reloadChanges()
            }}
            className="h-10 rounded-btn border border-border px-4 text-xs font-medium text-text-primary active:bg-card"
          >
            {t('diff.backToList')}
          </button>
        </div>
      ) : status === 'error' ? (
        <div data-diff-error={error} className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <p className="text-sm text-text-primary">{t(statusErrorKey(error))}</p>
          <button type="button" onClick={() => void fetchPage(0)} className="h-10 rounded-btn border border-border px-4 text-xs font-medium text-text-primary active:bg-card">
            {t('pending.retry')}
          </button>
        </div>
      ) : !load.head ? (
        status === 'noReply' ? (
          <NoReply onRetry={() => void fetchPage(0)} />
        ) : (
          <div data-diff-loading className="flex items-center justify-center gap-2 py-12 text-sm text-text-secondary">
            <Loader2 size={18} className="animate-spin" />
            {t('diff.loading')}
          </div>
        )
      ) : load.head.binary ? (
        <p data-diff-binary className="px-4 py-10 text-center text-sm text-text-secondary">{t('diff.binary')}</p>
      ) : load.head.tooLarge ? (
        <p data-diff-too-large className="px-4 py-10 text-center text-sm text-text-secondary">{t('diff.tooLarge', { lines: load.head.tooLarge.lines })}</p>
      ) : (
        <>
          {rows.length === 0 && load.done && <p data-diff-empty className="px-4 py-10 text-center text-sm text-text-secondary">{t('diff.empty')}</p>}
          <div data-diff-rows>
            {rows.map((row) =>
              row.kind === 'hunk' ? (
                <div
                  key={row.key}
                  data-diff-hunk
                  className="sticky top-0 z-10 whitespace-pre-wrap break-all border-y border-border bg-bg-secondary px-3 py-1 font-mono text-[11px] text-accent-blue"
                >
                  {row.header}
                </div>
              ) : (
                <div key={row.key}>
                  <LineRow
                    row={row}
                    noteable={noteable}
                    onNote={(r) =>
                      r.noteLine !== undefined &&
                      setDraft({ file: target.path, line: r.noteLine, lineText: lineTexts?.get(r.noteLine), maxLine: r.hunkEnd })
                    }
                  />
                  {row.noteLine !== undefined && row.line.kind !== 'del' && byLine.get(row.noteLine)?.map((n) => <NoteCard key={n.id} note={n} onEdit={editNote} />)}
                </div>
              ),
            )}
          </div>
          {status === 'loading' && (
            <div data-diff-more className="flex items-center justify-center py-4 text-text-secondary">
              <Loader2 size={18} className="animate-spin" />
            </div>
          )}
          {status === 'noReply' && <NoReply onRetry={() => void fetchPage(load.nextPage)} />}
          {status === 'unstable' && <p data-diff-unstable className="px-4 py-4 text-center text-xs text-text-secondary">{t('diff.unstable')}</p>}
        </>
      )}

      {load.done && status !== 'loading' && (
        <div className="px-4 pt-4">
          {next ? (
            <button
              type="button"
              data-diff-next={next.path}
              onClick={() => openDiff(diffTargetOf(next))}
              className="flex h-12 w-full items-center justify-center gap-1.5 rounded-btn border border-border text-sm font-medium text-text-primary active:bg-card"
            >
              {t('diff.next')}
              <span className="max-w-[50%] truncate font-mono text-xs text-text-secondary">{baseName(next.path)}</span>
              <ChevronRight size={16} />
            </button>
          ) : (
            <p data-diff-end className="text-center text-[11px] text-text-secondary">{t('diff.end')}</p>
          )}
        </div>
      )}

      <NoteSheet workspaceId={workspaceId} draft={draft} onClose={() => setDraft(null)} />
    </div>
  )
}

export function DiffScreen(): ReactNode {
  const workspaceId = useChangesStore((s) => s.workspaceId)
  const target = useChangesStore((s) => s.diff)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // The last file keeps the body mounted through the slide out.
  const last = useRef<{ workspaceId: string; target: DiffTarget } | null>(null)
  if (workspaceId && target) last.current = { workspaceId, target }
  const shown = workspaceId && target ? { workspaceId, target } : last.current
  const key = shown ? `${shown.target.area}:${shown.target.path}` : ''

  // "Next file" swaps the body in place: start it at the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [key])

  return (
    <PushScreen
      id="diff"
      open={workspaceId != null && target != null}
      onClose={closeDiff}
      title={shown ? baseName(shown.target.path) : ''}
      flush
      bodyRef={scrollRef}
      actions={shown && <NotesBadge workspaceId={shown.workspaceId} />}
    >
      {shown && <DiffBody key={key} workspaceId={shown.workspaceId} target={shown.target} scrollRef={scrollRef} />}
    </PushScreen>
  )
}
