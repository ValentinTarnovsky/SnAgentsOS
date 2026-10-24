import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, GitBranch, Loader2, RotateCw } from 'lucide-react'
import type { WorktreeInspectRes, WorktreeRemoveRes } from '@shared/worktree-types'
import { useAppStore } from '@/lib/store'
import { snapshotConfig } from '@/lib/persist'
import { useWorktreeStore, type WorktreeCloseRequest } from '@/lib/worktreeStore'
import { ackFields, deleteBlock, deleteNeedsAck, lostCommits, removeExpectations, worktreeUsers } from '@/lib/worktrees'
import { useT, type MessageKey } from '@/i18n'

/** Mounted once (App); shows while a close request is open. */
export function WorktreeCloseDialog() {
  const req = useWorktreeStore((s) => s.close)
  if (!req) return null
  return <CloseDialog key={`${req.paneId ?? ''}|${req.path}`} req={req} />
}

type RemoveError = Exclude<WorktreeRemoveRes, { ok: true }>

/**
 * The config to main now instead of 400 ms later (persist.ts): main refuses a
 * delete as 'shared' from the saved consoles, and config:save is a send that
 * lands before the remove invoke, so a console closed just before never counts.
 */
function saveConfigNow(): void {
  if (!useAppStore.getState().hydrated) return
  try {
    window.snApi.config.save(snapshotConfig())
  } catch {
    /* the debounced save still goes */
  }
}

/**
 * Closing a console that runs in a worktree (E7-FR-30): the branch, the
 * uncommitted files, the commits not in the base and whether the branch is
 * merged into the workspace HEAD. "Keep worktree" (focused) only closes the
 * console; "Delete worktree and branch" asks main, which kills the shell
 * first, and needs the checkbox when work would be lost. A half-done git
 * operation or another branch checked out blocks Delete; a worktree that
 * moved on after this read ('changed' from main) is read again. The pane leaves the
 * store only after main said ok, or on Keep. Without a pane (an orphan in
 * Settings, FR-31) there is no Keep. While another console still runs in
 * the same folder (app 2.7.0, A9) Delete is not offered: main would only
 * kill this console's shell and the other one keeps the folder in use.
 */
function CloseDialog({ req }: { req: WorktreeCloseRequest }) {
  const t = useT()
  const closeDialog = useWorktreeStore((s) => s.closeClose)
  const [info, setInfo] = useState<WorktreeInspectRes | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RemoveError | null>(null)
  // Main said 'changed': the data below was read again after the click.
  const [changed, setChanged] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)
  const liveRef = useRef(true)
  const hasPane = !!(req.paneId && req.workspaceId)
  // The other consoles (any workspace) whose worktree is this folder.
  const others = useAppStore((s) => worktreeUsers(s.workspaces, req.path, req.paneId))

  const inspect = (): Promise<WorktreeInspectRes> =>
    window.snApi.git
      .worktreeInspect({ path: req.path, ...(req.base ? { base: req.base } : {}) })
      // Unknown is not "gone": deleting still asks for the checkbox.
      .catch((): WorktreeInspectRes => ({ exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false, incomplete: true }))

  useEffect(() => {
    liveRef.current = true
    void inspect().then((r) => liveRef.current && setInfo(r))
    return () => {
      liveRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.path, req.base])

  useEffect(() => {
    keepRef.current?.focus()
  }, [])

  const cancel = (): void => {
    if (!busy) closeDialog()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const keep = (): void => {
    if (busy) return
    if (hasPane) useAppStore.getState().closePane(req.workspaceId!, req.paneId!)
    closeDialog()
  }

  // A gone folder too: its branch delete still drops the commits main counted in the repo.
  const needsAck = info ? deleteNeedsAck(info) : false
  const block = info ? deleteBlock(info, req.branch) : null
  const shared = others > 0
  const canDelete = !!info && !busy && !block && !shared && (!needsAck || ack)

  const remove = async (): Promise<void> => {
    if (!canDelete || !info) return
    setBusy(true)
    setError(null)
    let res: WorktreeRemoveRes
    saveConfigNow()
    try {
      res = await window.snApi.git.worktreeRemove({ path: req.path, ...(req.paneId ? { paneId: req.paneId } : {}), deleteBranch: true, ...removeExpectations(info), ...ackFields(info, ack) })
    } catch (e) {
      res = { ok: false, error: 'git_error', detail: String((e as Error)?.message ?? e) }
    }
    if (!res.ok && res.error === 'changed') {
      // The worktree moved on after this dialog read it (a commit, new files,
      // a rebase): show the fresh state and ask again, checkbox cleared.
      const fresh = await inspect()
      if (!liveRef.current) return
      setInfo(fresh)
      setAck(false)
      setChanged(true)
      setBusy(false)
      return
    }
    setBusy(false)
    if (!res.ok) {
      setError(res)
      return
    }
    // Deleted for good: not on the reopen stack (its worktree is gone).
    if (hasPane) useAppStore.getState().removePane(req.workspaceId!, req.paneId!)
    closeDialog()
  }

  const files = info?.dirtyFiles ?? 0
  const commits = info ? lostCommits(info) : 0

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6" data-worktree-close>
      <div className="absolute inset-0 bg-black/60" onClick={cancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-close-title"
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="space-y-3 p-5">
          <h2 id="worktree-close-title" className="text-sm font-semibold text-text-primary">
            {hasPane ? t('worktree.close.title') : t('worktree.close.deleteTitle')}
          </h2>
          <p className="flex min-w-0 items-center gap-1.5 font-mono text-sm text-text-primary">
            <GitBranch size={14} className="shrink-0 text-accent-violet" />
            <span data-worktree-close-branch className="truncate">{req.branch}</span>
          </p>
          <p className="break-all font-mono text-[11px] text-text-secondary">{req.path}</p>
          {!info ? (
            <p className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Loader2 size={13} className="animate-spin" />
              {t('worktree.close.checking')}
            </p>
          ) : !info.exists ? (
            <ul data-worktree-close-info className="space-y-1 text-xs text-state-action">
              <li>{t('worktree.close.gone')}</li>
              {commits > 0 && <li data-worktree-close-lost>{t('worktree.close.ahead', { count: commits })}</li>}
              {info.incomplete && <li data-worktree-close-incomplete>{t('worktree.close.incomplete')}</li>}
            </ul>
          ) : (
            <ul data-worktree-close-info className="space-y-1 text-xs text-text-secondary">
              {/* An unread count is not "clean": the incomplete line below says so. */}
              {!(info.incomplete && !info.dirtyRead) && (
                <li className={files > 0 ? 'text-state-action' : undefined}>
                  {files > 0 ? t('worktree.close.dirty', { count: files }) : t('worktree.close.clean')}
                </li>
              )}
              <li className={commits > 0 ? 'text-state-action' : undefined}>{t('worktree.close.ahead', { count: info.commitsAhead })}</li>
              <li>{info.mergedIntoHead ? t('worktree.close.merged') : t('worktree.close.notMerged')}</li>
              {(info.behindMain ?? 0) > 0 && <li data-worktree-close-behind={info.behindMain}>{t('worktree.close.behindMain', { count: info.behindMain ?? 0 })}</li>}
              {info.incomplete && (
                <li data-worktree-close-incomplete className="text-state-action">
                  {t('worktree.close.incomplete')}
                </li>
              )}
            </ul>
          )}
          {changed && (
            <p data-worktree-close-changed role="status" className="rounded-btn border border-state-action/40 bg-state-action/10 px-3 py-2 text-xs text-text-primary">
              {t('worktree.close.changed')}
            </p>
          )}
          {block && (
            <p data-worktree-close-blocked={block} role="alert" className="rounded-btn border border-state-error/40 bg-state-error/10 px-3 py-2 text-xs text-state-error">
              {block === 'inProgress'
                ? t('worktree.close.inProgress', { op: info?.inProgress ?? '' })
                : info?.headBranch
                  ? t('worktree.close.branchMismatch', { branch: info.headBranch })
                  : t('worktree.close.detached')}
            </p>
          )}
          {shared && (
            <p data-worktree-close-shared={others} role="status" className="rounded-btn border border-state-action/40 bg-state-action/10 px-3 py-2 text-xs text-text-primary">
              {others === 1 ? t('worktree.close.sharedOne') : t('worktree.close.shared', { count: others })}
            </p>
          )}
          {needsAck && !block && !shared && (
            <label className="flex items-start gap-2 rounded-btn border border-state-error/40 bg-state-error/10 px-3 py-2 text-xs text-text-primary">
              <input type="checkbox" data-worktree-ack checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-[var(--color-state-error)]" />
              {info?.incomplete ? t('worktree.close.ackUnknown') : t('worktree.close.ack', { files, commits })}
            </label>
          )}
          {error && (
            <div data-worktree-close-error role="alert" className="space-y-2 rounded-btn border border-state-error/40 bg-state-error/10 px-3 py-2 text-xs text-state-error">
              <p className="break-words">{t(`worktree.rmErr.${error.error}` as MessageKey, { detail: error.detail ?? '' })}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => void remove()}
                  className="flex items-center gap-1 rounded-btn border border-border bg-card px-2 py-1 text-text-primary transition-colors hover:border-accent-violet/40"
                >
                  <RotateCw size={12} />
                  {t('worktree.close.retry')}
                </button>
                <button
                  onClick={() => void window.snApi.git.worktreeReveal(req.path)}
                  className="flex items-center gap-1 rounded-btn border border-border bg-card px-2 py-1 text-text-primary transition-colors hover:border-accent-violet/40"
                >
                  <FolderOpen size={12} />
                  {t('worktree.close.openFolder')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            onClick={cancel}
            disabled={busy}
            className="rounded-btn border border-border px-3 py-2 text-sm text-text-primary transition-colors hover:bg-card disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          {!shared && (
            <button
              data-worktree-delete
              onClick={() => void remove()}
              disabled={!canDelete}
              className="flex items-center gap-1.5 rounded-btn border border-red-400/50 bg-red-500/90 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? t('worktree.close.deleting') : t('worktree.close.delete')}
            </button>
          )}
          {hasPane && (
            <button
              ref={keepRef}
              data-worktree-keep
              onClick={keep}
              disabled={busy}
              className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-3 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40"
            >
              {t('worktree.close.keep')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
