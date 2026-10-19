/**
 * Changes (E3-FR-52), a pushed screen per workspace opened from the git chip
 * on Home or from the terminal's kebab. It reads the status page by page
 * (gitReq op:'status'), shows `main +142 -37 · 5 files` with ahead/behind and
 * any merge/rebase in progress, then the sections Conflicts / Staged / Not
 * staged / Untracked with each file's M/A/D/R/U/? badge and +N -M. A file
 * opens its diff (DiffScreen). A workspace without a repo shows "This
 * workspace is not a git repo"; no answer in 10s (or main's rate/timeout)
 * shows "The PC did not answer [Retry]". The header holds the notes badge and
 * a refresh button.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { GitBranch, Loader2, RotateCw } from 'lucide-react'
import type { GitArea, GitFileEntry } from '@shared/git-types'
import type { RemoteGitChanges } from '@shared/remote-protocol'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { NotesBadge } from './NotesBadge'
import { store, useRemoteStore } from '../../lib/store'
import { client } from '../../lib/client'
import {
  baseName,
  closeChanges,
  diffTargetOf,
  dirName,
  gitOutcome,
  groupChanges,
  mergeStatus,
  openDiff,
  orderedFiles,
  reloadChanges,
  statusBadge,
  statusErrorKey,
  STATUS_MAX_PAGES,
  useChangesStore,
  type StatusView,
} from '../../lib/changes'
import { isSent, useNotesStore } from '../../lib/notesStore'
import { t, type MobileMessageKey } from '../../lib/i18n'

type ListState =
  | { status: 'loading'; view: StatusView | null }
  | { status: 'ok'; view: StatusView }
  | { status: 'noReply'; view: StatusView | null }
  | { status: 'error'; view: null; error: string }

const SECTION_KEY: Record<GitArea, MobileMessageKey> = {
  conflict: 'changes.section.conflict',
  staged: 'changes.section.staged',
  unstaged: 'changes.section.unstaged',
  untracked: 'changes.section.untracked',
}

/** Badge color: conflicts and deletions red, new files green, the rest blue. */
function badgeClass(badge: string): string {
  if (badge === 'U' || badge === 'D') return 'text-ansi-red'
  if (badge === 'A' || badge === '?') return 'text-ansi-green'
  return 'text-accent-blue'
}

/** `main +142 -37 · 5 files` (FR-52), with `+` after the added count when it is approximate. */
function SummaryCard({ summary }: { summary: RemoteGitChanges['summary'] }): ReactNode {
  return (
    <div data-changes-header className="flex flex-col gap-1.5 rounded-card border border-border bg-bg-secondary p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[13px] text-text-primary">
        <GitBranch size={14} className="shrink-0 text-text-secondary" />
        <span data-changes-branch className="min-w-0 truncate font-semibold">{summary.branch}</span>
        <span data-changes-counts className="shrink-0">
          <span className="text-ansi-green">+{summary.added}{summary.approx ? '+' : ''}</span>{' '}
          <span className="text-ansi-red">-{summary.removed}</span>
          <span className="text-text-secondary"> · {summary.files === 1 ? t('changes.file1') : t('changes.files', { n: summary.files })}</span>
        </span>
        {summary.ahead > 0 && (
          <span data-changes-ahead aria-label={t('changes.ahead', { n: summary.ahead })} className="shrink-0 text-text-secondary">
            ↑{summary.ahead}
          </span>
        )}
        {summary.behind > 0 && (
          <span data-changes-behind aria-label={t('changes.behind', { n: summary.behind })} className="shrink-0 text-text-secondary">
            ↓{summary.behind}
          </span>
        )}
      </div>
      {(summary.op || summary.conflicts > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {summary.op && (
            <span data-changes-op={summary.op} className="rounded-full bg-state-action/15 px-2 py-0.5 text-[11px] font-medium text-state-action">
              {t(`changes.op.${summary.op}` as MobileMessageKey)}
            </span>
          )}
          {summary.conflicts > 0 && (
            <span data-changes-conflicts className="rounded-full bg-state-error/15 px-2 py-0.5 text-[11px] font-medium text-state-error">
              {t('changes.conflicts', { n: summary.conflicts })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function FileRow({ file, notes, onOpen }: { file: GitFileEntry; notes: number; onOpen: (f: GitFileEntry) => void }): ReactNode {
  const badge = statusBadge(file)
  const dir = dirName(file.path)
  return (
    <button
      type="button"
      data-changes-file={file.path}
      data-area={file.area}
      onClick={() => onOpen(file)}
      className="flex min-h-12 w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 active:bg-card"
    >
      <span data-file-badge={badge} className={clsx('w-4 shrink-0 text-center font-mono text-[13px] font-bold', badgeClass(badge))}>
        {badge}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-text-primary">{baseName(file.path)}</span>
        {(dir || file.oldPath) && (
          <span className="truncate font-mono text-[11px] text-text-secondary">
            {file.oldPath ? t('changes.renamedFrom', { old: file.oldPath }) : dir}
          </span>
        )}
      </span>
      {notes > 0 && (
        <span data-file-notes={notes} className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent-violet px-1.5 text-[10px] font-bold text-white">
          {notes}
        </span>
      )}
      <span data-file-counts className="shrink-0 font-mono text-xs">
        {file.binary || file.added === null ? (
          <span className="text-text-secondary">{t('changes.binary')}</span>
        ) : (
          <>
            <span className="text-ansi-green">+{file.added}</span> <span className="text-ansi-red">-{file.removed ?? 0}</span>
          </>
        )}
      </span>
    </button>
  )
}

/** The screen body, mountable without the PushScreen chrome (tests). */
export function ChangesBody({ workspaceId }: { workspaceId: string }): ReactNode {
  const reloadSeq = useChangesStore((s) => s.reloadSeq)
  const [list, setList] = useState<ListState>({ status: 'loading', view: null })
  const [round, setRound] = useState(0)
  const viewRef = useRef<StatusView | null>(null)
  const notes = useNotesStore((s) => s.byWs[workspaceId])

  useEffect(() => {
    useNotesStore.getState().ensure(workspaceId)
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    setList((prev) => ({ status: 'loading', view: prev.view }))
    void (async () => {
      let view: StatusView | null = null
      for (let page = 0; page < STATUS_MAX_PAGES; page++) {
        const out = gitOutcome<RemoteGitChanges>(await client.requestGit({ workspaceId, op: 'status', page }))
        if (cancelled) return
        if (out.kind === 'noReply') {
          setList({ status: 'noReply', view: view ?? viewRef.current })
          return
        }
        if (out.kind === 'error') {
          viewRef.current = null
          useChangesStore.getState().update({ files: [] })
          setList({ status: 'error', view: null, error: out.error })
          return
        }
        view = mergeStatus(view, page, out.data, out.done)
        if (out.done) break
      }
      if (!view) return
      viewRef.current = view
      useChangesStore.getState().update({ files: orderedFiles(view.files) })
      // A complete list tells which noted files have no changes left (FR-54).
      if (view.complete && !view.truncated) useNotesStore.getState().markGoneFiles(workspaceId, new Set(view.files.map((f) => f.path)))
      setList({ status: 'ok', view })
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId, reloadSeq, round])

  const view = list.view
  const pendingByFile = new Map<string, number>()
  for (const n of notes ?? []) if (!isSent(n)) pendingByFile.set(n.file, (pendingByFile.get(n.file) ?? 0) + 1)

  if (list.status === 'error') {
    const notRepo = list.error === 'not_repo'
    return (
      <div data-changes-body={workspaceId} data-changes-status="error" data-changes-error={list.error} className="flex flex-col items-center gap-3 py-12 text-center">
        <GitBranch size={28} className="text-text-secondary" />
        <p data-changes-empty className="text-sm text-text-primary">{t(statusErrorKey(list.error))}</p>
        {!notRepo && (
          <button type="button" onClick={() => setRound((r) => r + 1)} className="h-10 rounded-btn border border-border px-4 text-xs font-medium text-text-primary active:bg-card">
            {t('pending.retry')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div data-changes-body={workspaceId} data-changes-status={list.status} className="flex flex-col gap-4">
      {list.status === 'noReply' && <NoReply onRetry={() => setRound((r) => r + 1)} />}
      {!view ? (
        list.status === 'loading' && (
          <div data-changes-loading className="flex items-center justify-center gap-2 py-12 text-sm text-text-secondary">
            <Loader2 size={18} className="animate-spin" />
            {t('changes.loading')}
          </div>
        )
      ) : (
        <>
          <SummaryCard summary={view.summary} />
          {view.files.length === 0 ? (
            <div data-changes-clean className="flex flex-col items-center gap-1 py-10 text-center">
              <p className="text-sm font-medium text-text-primary">{t('changes.clean')}</p>
              <p className="text-xs text-text-secondary">{t('changes.cleanBody')}</p>
            </div>
          ) : (
            groupChanges(view.files).map((g) => (
              <section key={g.area} data-changes-section={g.area} className="flex flex-col gap-1.5">
                <h3 className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  {t(SECTION_KEY[g.area])}
                  <span data-section-count className="font-normal">{g.files.length}</span>
                </h3>
                <div className="overflow-hidden rounded-card border border-border bg-bg-secondary">
                  {g.files.map((f) => (
                    <FileRow key={`${f.area}:${f.path}`} file={f} notes={pendingByFile.get(f.path) ?? 0} onOpen={(file) => openDiff(diffTargetOf(file))} />
                  ))}
                </div>
              </section>
            ))
          )}
          {view.truncated && <p data-changes-truncated className="px-1 text-center text-[11px] text-text-secondary">{t('changes.truncated')}</p>}
          {!view.truncated && view.files.length < view.total && (
            <p data-changes-partial className="px-1 text-center text-[11px] text-text-secondary">
              {t('changes.partial', { shown: view.files.length, total: view.total })}
            </p>
          )}
        </>
      )}
    </div>
  )
}

export function ChangesScreen(): ReactNode {
  const workspaceId = useChangesStore((s) => s.workspaceId)
  const exists = useRemoteStore((s) => !!workspaceId && !!s.snapshot?.workspaces.some((w) => w.id === workspaceId))
  // The workspace went away on the desktop: nothing to show.
  useEffect(() => {
    if (workspaceId && !exists && store.getState().snapshot) closeChanges()
  }, [workspaceId, exists])
  // The last workspace keeps the body mounted through the slide out.
  const last = useRef<string | null>(null)
  if (workspaceId) last.current = workspaceId
  const shownWs = workspaceId ?? last.current
  return (
    <PushScreen
      id="changes"
      open={workspaceId != null}
      onClose={closeChanges}
      title={t('changes.title')}
      actions={
        shownWs && (
          <>
            <NotesBadge workspaceId={shownWs} />
            <button
              type="button"
              data-changes-refresh
              onClick={reloadChanges}
              aria-label={t('changes.refresh')}
              className="flex h-11 w-11 items-center justify-center rounded-btn text-text-secondary active:bg-card"
            >
              <RotateCw size={18} />
            </button>
          </>
        )
      }
    >
      {shownWs && <ChangesBody key={shownWs} workspaceId={shownWs} />}
    </PushScreen>
  )
}
