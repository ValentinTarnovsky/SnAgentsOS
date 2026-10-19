import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Clipboard, Crown, FileDiff, Flag, Hourglass, Loader2, Trash2, TriangleAlert, X } from 'lucide-react'
import type { GitBaseStat } from '@shared/git-types'
import type { Workspace } from '@shared/types'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { useGitStore } from '@/lib/gitStore'
import { paneGitKey } from '@/lib/gitChip'
import { openChangesPanel } from '@/lib/changesPanel'
import { toast } from '@/lib/toast'
import {
  checkoutCommand,
  discardContestant,
  discardOthers,
  keepLoss,
  liveContestants,
  planKeep,
  stateKey,
  useRaceStore,
  type KeepPlanRow,
  type Race,
  type RaceContestant,
} from '@/lib/race'
import { PaneStatusDot } from '@/components/ui/StatusDot'
import { Tooltip } from '@/components/ui/Tooltip'

/**
 * The race bar (E7-FR-35): over the grid of a workspace with a race, one row
 * per contestant still on screen with its state glyph, its branch and its
 * `+a -d N files` against the base (committed work included). Actions:
 * [View changes] (the Changes panel "against base"), [Copy git checkout],
 * [Discard] (FR-30: at once when clean, else the close dialog) and "Keep this
 * one" (offers to delete the others). Nothing here ever merges. Closing the
 * bar ends the race and leaves every console and worktree as they are.
 */
export function RaceBar({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const race = useRaceStore((s) => s.races[workspace.id])
  const end = useRaceStore((s) => s.end)
  const [keep, setKeep] = useState<RaceContestant | null>(null)
  const rows = race ? liveContestants(race, workspace) : []

  // The last contestant gone (discarded or closed) ends the race.
  useEffect(() => {
    if (race && rows.length === 0) end(workspace.id)
  }, [race, rows.length, end, workspace.id])

  if (!race || rows.length === 0) return null

  return (
    <div className="shrink-0 border-b border-border bg-bg-secondary/40 px-3 py-1.5" role="region" aria-label={t('race.bar.title')} data-race-bar>
      <div className="flex min-w-0 items-center gap-2 pb-1 text-[11px] text-text-secondary">
        <Flag size={12} className="shrink-0 text-accent-violet" />
        <span className="shrink-0 font-semibold uppercase tracking-wide">{t('race.bar.title')}</span>
        <span className="min-w-0 flex-1 truncate text-text-primary" title={race.task} data-race-task>
          {race.task.replace(/\s+/g, ' ')}
        </span>
        <span className="shrink-0 font-mono">{t('race.bar.base', { sha: race.base.slice(0, 7) })}</span>
        <Tooltip label={t('race.bar.end')} side="bottom">
          <button type="button" onClick={() => end(workspace.id)} aria-label={t('race.bar.end')} className="rounded-btn p-0.5 hover:bg-card hover:text-text-primary" data-race-end>
            <X size={13} />
          </button>
        </Tooltip>
      </div>
      <ul className="space-y-0.5">
        {rows.map((c) => (
          <RaceRow key={c.paneId} race={race} c={c} title={workspace.panes.find((p) => p.id === c.paneId)?.title ?? c.branch} onKeep={() => setKeep(c)} />
        ))}
      </ul>
      {keep && <KeepDialog workspaceId={workspace.id} keep={keep} onClose={() => setKeep(null)} />}
    </div>
  )
}

function StateGlyph({ c }: { c: RaceContestant }) {
  const t = useT()
  const label = t(stateKey(c.state))
  let icon
  if (c.state === 'starting') icon = <Hourglass size={12} className="text-text-secondary" />
  else if (c.state === 'failed') icon = <TriangleAlert size={12} className="text-state-error" />
  else if (c.state === 'late') icon = <TriangleAlert size={12} className="text-state-action" />
  else icon = <Check size={12} className="text-ansi-green" />
  return (
    <Tooltip label={label} side="bottom">
      <span className="flex shrink-0 items-center" aria-label={label} data-race-state={c.state}>
        {icon}
      </span>
    </Tooltip>
  )
}

function RaceRow({ race, c, title, onKeep }: { race: Race; c: RaceContestant; title: string; onKeep: () => void }) {
  const t = useT()
  const key = paneGitKey(c.paneId)
  // Any summary change of the worktree (a save, a commit) re-reads the stat against the base.
  const summary = useGitStore((s) => s.summaries[key])
  const [stat, setStat] = useState<GitBaseStat | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.snApi.git
      .baseStat({ key, base: race.base })
      .then((r) => live && r && setStat(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key, race.base, summary])

  const copy = (): void => {
    const cmd = checkoutCommand(c.branch)
    window.snApi.clipboard.writeText(cmd)
    toast.success(t('race.toast.copied', { cmd }), { dedupeKey: 'race-copy' })
  }
  const discard = async (): Promise<void> => {
    setBusy(true)
    await discardContestant(race.workspaceId, c.paneId)
    setBusy(false)
  }
  const btn = 'flex shrink-0 items-center gap-1 rounded-btn px-1.5 py-0.5 text-text-secondary hover:bg-card hover:text-text-primary disabled:opacity-40'

  return (
    <li className="flex min-w-0 items-center gap-2 text-xs" data-race-row={c.paneId}>
      <StateGlyph c={c} />
      <PaneStatusDot paneId={c.paneId} />
      <span className="min-w-0 max-w-[30%] shrink truncate text-text-primary">{title}</span>
      <span className="min-w-0 shrink truncate font-mono text-[11px] text-text-secondary">{c.branch}</span>
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px]" data-race-stat>
        {stat ? (
          <>
            <span className="text-ansi-green">+{stat.added}{stat.approx ? '+' : ''}</span> <span className="text-ansi-red">-{stat.removed}</span>{' '}
            <span className="text-text-secondary">{t('race.bar.files', { count: stat.files })}</span>
          </>
        ) : (
          <span className="text-text-secondary">-</span>
        )}
      </span>
      <span className="flex-1" />
      <button type="button" className={btn} onClick={() => openChangesPanel(key, { base: race.base })} data-race-view>
        <FileDiff size={12} />
        <span className="hidden lg:inline">{t('race.act.view')}</span>
      </button>
      <Tooltip label={checkoutCommand(c.branch)} side="bottom">
        <button type="button" className={btn} onClick={copy} aria-label={t('race.act.copy')} data-race-copy>
          <Clipboard size={12} />
          <span className="hidden lg:inline">{t('race.act.copy')}</span>
        </button>
      </Tooltip>
      <button type="button" className={btn} onClick={() => void discard()} disabled={busy} data-race-discard>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        <span className="hidden lg:inline">{t('race.act.discard')}</span>
      </button>
      <button type="button" className={cn(btn, 'text-accent-violet')} onClick={onKeep} data-race-keep>
        <Crown size={12} />
        <span className="hidden lg:inline">{t('race.act.keep')}</span>
      </button>
    </li>
  )
}

/**
 * "Keep this one": lists the other contestants with what deleting each one
 * loses and, as in FR-30, asks for the checkbox when any would lose work.
 * Deletes worktree and branch of the others; the kept one is untouched.
 */
function KeepDialog({ workspaceId, keep, onClose }: { workspaceId: string; keep: RaceContestant; onClose: () => void }) {
  const t = useT()
  const [rows, setRows] = useState<KeepPlanRow[] | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    void planKeep(workspaceId, keep.paneId).then((r) => live && setRows(r))
    cancelRef.current?.focus()
    return () => {
      live = false
    }
  }, [workspaceId, keep.paneId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])

  const loss = rows ? keepLoss(rows) : { needsAck: false, files: 0, commits: 0 }
  const canDelete = !!rows && rows.length > 0 && !busy && (!loss.needsAck || ack)
  const confirm = async (): Promise<void> => {
    if (!canDelete || !rows) return
    setBusy(true)
    await discardOthers(workspaceId, rows)
    setBusy(false)
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6" data-race-keep-dialog>
      <div className="absolute inset-0 bg-black/60" onClick={() => !busy && onClose()} />
      <div role="dialog" aria-modal="true" aria-labelledby="race-keep-title" className="relative z-10 w-full max-w-md overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="space-y-3 p-5">
          <h2 id="race-keep-title" className="text-sm font-semibold text-text-primary">
            {t('race.keep.title', { branch: keep.branch })}
          </h2>
          {!rows ? (
            <p className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Loader2 size={13} className="animate-spin" />
              {t('worktree.close.checking')}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-text-secondary">{t('race.keep.none')}</p>
          ) : (
            <>
              <p className="text-xs text-text-secondary">{t('race.keep.msg', { count: rows.length, branch: keep.branch })}</p>
              <ul className="space-y-1 text-xs" data-race-keep-rows>
                {rows.map((r) => {
                  const commits = r.info.mergedIntoHead ? 0 : r.info.commitsAhead
                  const dirty = r.info.dirtyFiles > 0 || commits > 0 || r.info.incomplete
                  return (
                    <li key={r.paneId} className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-text-primary">{r.branch}</span>
                      <span className={cn('shrink-0', dirty ? 'text-state-action' : 'text-text-secondary')}>
                        {!r.info.exists ? t('worktree.close.gone') : dirty ? t('race.keep.dirty', { files: r.info.dirtyFiles, commits }) : t('race.keep.clean')}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {loss.needsAck && (
                <label className="flex items-start gap-2 rounded-btn border border-state-error/40 bg-state-error/10 px-3 py-2 text-xs text-text-primary">
                  <input type="checkbox" data-race-keep-ack checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-[var(--color-state-error)]" />
                  {t('worktree.close.ack', { files: loss.files, commits: loss.commits })}
                </label>
              )}
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button ref={cancelRef} type="button" onClick={onClose} disabled={busy} className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card disabled:opacity-40">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!canDelete}
            className="flex items-center gap-1.5 rounded-btn border border-red-400/50 bg-red-500/90 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            data-race-keep-confirm
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t('race.keep.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
