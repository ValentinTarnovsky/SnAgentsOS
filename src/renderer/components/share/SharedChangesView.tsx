import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { GitFileEntry } from '@shared/git-types'
import type { RemoteGitChanges, RemoteGitDiffPage } from '@shared/remote-protocol'
import type { ShareGuestGitRes, ShareLinkView } from '@shared/share-guest'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/lib/store'
import { groupFiles, rowCounts, rowKey, splitName } from '@/lib/changes'
import {
  SHARE_STATUS_MAX_PAGES,
  applyDiffPage,
  diffResOf,
  emptyDiffLoad,
  gitOutcome,
  liveKeyOf,
  mergeStatus,
  type ShareDiffLoad,
  type ShareStatusView,
} from '@/lib/shareGuestExtras'
import { DiffView } from '@/components/changes/DiffView'

const GIT_ERR_KEY: Record<string, MessageKey> = {
  not_repo: 'changes.err.not_repo',
  git_missing: 'changes.err.git_missing',
  git_old: 'changes.err.git_old',
  unsafe_repo: 'changes.err.unsafe_repo',
  timeout: 'changes.err.timeout',
  not_found: 'shareGuest.changes.unavailable',
}

function errText(t: (k: MessageKey) => string, error: string): string {
  return t(GIT_ERR_KEY[error] ?? 'changes.err.git_error')
}

/** Status letter colors, like the local Changes list. */
function statusClass(s: GitFileEntry['status']): string {
  if (s === 'U' || s === 'D') return 'text-ansi-red'
  if (s === 'A' || s === '?') return 'text-ansi-green'
  if (s === 'R' || s === 'C') return 'text-accent-blue'
  return 'text-state-action'
}

type Fetch = (req: { op: 'status' | 'diff'; path?: string; staged?: boolean; page?: number }) => Promise<ShareGuestGitRes>

/**
 * Changes of a shared workspace, read only (app 2.4.0, item 8, S5): the
 * host's git status in sections (conflicts, staged, unstaged, untracked) and
 * the picked file's diff, read page by page like the phone. Paths are
 * relative to the host repo; the host only diffs paths its status listed.
 * There is no stage, discard, open nor drag: nothing of the host's disk
 * reaches this PC beyond what the pages carry.
 */
export function SharedChangesView({ link, reloadSeq }: { link: ShareLinkView; reloadSeq: number }) {
  const t = useT()
  const linkId = link.id
  const liveKey = liveKeyOf(link)
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const [status, setStatus] = useState<ShareStatusView | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [selected, setSelected] = useState<GitFileEntry | null>(null)
  const [diff, setDiff] = useState<ShareDiffLoad>(() => emptyDiffLoad())
  const [diffErr, setDiffErr] = useState<string | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  const [unstable, setUnstable] = useState(false)
  const gen = useRef(0)
  const diffGen = useRef(0)

  const fetchGit = useCallback<Fetch>(
    (req) => window.snApi.share.guest.git({ linkId, ...req }).catch((): ShareGuestGitRes => ({ ok: false, error: 'offline' })),
    [linkId],
  )

  const loadStatus = useCallback(async () => {
    const my = ++gen.current
    setStatusBusy(true)
    let view: ShareStatusView | null = null
    for (let page = 0; page < SHARE_STATUS_MAX_PAGES; page++) {
      const out = gitOutcome<RemoteGitChanges>(await fetchGit({ op: 'status', page }))
      if (my !== gen.current) return
      if (out.kind !== 'data') {
        if (page === 0) {
          setStatus(null)
          setStatusErr(out.kind === 'noReply' ? 'noReply' : out.error)
        }
        break
      }
      view = mergeStatus(view, out.page, out.data, out.done)
      setStatus(view)
      setStatusErr(null)
      if (out.done) break
    }
    setStatusBusy(false)
  }, [fetchGit])

  useEffect(() => {
    if (liveKey !== null) void loadStatus()
  }, [liveKey, reloadSeq, loadStatus])

  const readDiff = useCallback(
    async (file: GitFileEntry, load: ShareDiffLoad) => {
      const my = ++diffGen.current
      setDiffBusy(true)
      let cur = load
      // A file that changed under the reader starts over (at most twice).
      for (;;) {
        const out = gitOutcome<RemoteGitDiffPage>(await fetchGit({ op: 'diff', path: file.path, staged: file.area === 'staged', page: cur.nextPage }))
        if (my !== diffGen.current) return
        if (out.kind !== 'data') {
          setDiffErr(out.kind === 'noReply' ? 'noReply' : out.error)
          break
        }
        const r = applyDiffPage(cur, out.page, out.data, out.done)
        cur = r.load
        setDiff(cur)
        setDiffErr(null)
        if (r.unstable) setUnstable(true)
        if (!r.restart) break
      }
      setDiffBusy(false)
    },
    [fetchGit],
  )

  const pick = (f: GitFileEntry): void => {
    setSelected(f)
    setUnstable(false)
    setDiffErr(null)
    const fresh = emptyDiffLoad()
    setDiff(fresh)
    void readDiff(f, fresh)
  }

  // The picked file left the list (a refresh): its diff goes too.
  useEffect(() => {
    if (!selected || !status) return
    if (!status.files.some((f) => rowKey(f) === rowKey(selected))) {
      diffGen.current++
      setSelected(null)
      setDiff(emptyDiffLoad())
    }
  }, [status, selected])

  const sections = useMemo(() => groupFiles(status?.files ?? []), [status])
  const res = useMemo(() => diffResOf(diff), [diff])
  const s = status?.summary

  let diffBody: ReactNode
  if (!selected) diffBody = <p className="pt-8 text-center text-sm text-text-secondary">{t('changes.pickFile')}</p>
  else if (diffErr) {
    diffBody = (
      <div className="space-y-2 pt-8 text-center text-sm text-text-secondary" data-shared-diff-error={diffErr}>
        <p>{diffErr === 'noReply' ? t('shareGuest.extras.noReply') : diffErr === 'not_found' ? t('changes.gone') : errText(t, diffErr)}</p>
        {diffErr === 'noReply' && (
          <button type="button" onClick={() => void readDiff(selected, diff)} className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card">
            {t('shareGuest.extras.retry')}
          </button>
        )}
      </div>
    )
  } else if (!res) {
    diffBody = diffBusy ? (
      <div className="flex justify-center pt-8 text-text-secondary">
        <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-label={t('changes.loading')} />
      </div>
    ) : null
  } else if (diff.head?.tooLarge) diffBody = <p className="pt-8 text-center text-sm text-text-secondary">{t('changes.tooLarge', { lines: diff.head.tooLarge.lines })}</p>
  else if (res.binary) diffBody = <p className="pt-8 text-center text-sm text-text-secondary">{t('changes.binary')}</p>
  else if (res.hunks.length === 0 && diff.done) diffBody = <p className="pt-8 text-center text-sm text-text-secondary">{t('changes.emptyFile')}</p>
  else diffBody = <DiffView diff={res} wrap={false} fontFamily={fontFamily} fontSize={12} notes={null} />

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shared-changes>
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs text-text-secondary" data-shared-changes-summary>
        {s ? (
          <>
            <span className="truncate font-medium text-text-primary">{s.branch}</span>
            <span>{t('shareGuest.changes.files', { n: status?.total ?? 0 })}</span>
            <span className="font-mono">
              <span className="text-ansi-green">+{s.added}</span> <span className="text-ansi-red">-{s.removed}</span>
            </span>
            {s.op && <span className="text-state-action">{s.op}</span>}
          </>
        ) : statusBusy ? (
          <span>{t('changes.loading')}</span>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border py-1 text-xs" data-shared-changes-list>
          {statusErr && (
            <div className="space-y-2 px-3 py-3 text-text-secondary" data-shared-changes-error={statusErr}>
              <p>{statusErr === 'noReply' ? t('shareGuest.extras.noReply') : errText(t, statusErr)}</p>
              <button type="button" onClick={() => void loadStatus()} className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card">
                {t('shareGuest.extras.retry')}
              </button>
            </div>
          )}
          {status && status.files.length === 0 && <p className="px-3 py-3 text-text-secondary">{t('changes.clean')}</p>}
          {sections.map((sec) => (
            <div key={sec.area} data-shared-changes-section={sec.area}>
              <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                {t(`changes.section.${sec.area}` as MessageKey)} ({sec.files.length})
              </div>
              {sec.files.map((f) => {
                const { name, dir } = splitName(f.path)
                const k = rowKey(f)
                return (
                  <button
                    key={k}
                    type="button"
                    data-shared-change={k}
                    aria-current={selected && rowKey(selected) === k ? 'true' : undefined}
                    onClick={() => pick(f)}
                    className={cn('flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-card', selected && rowKey(selected) === k && 'bg-card')}
                  >
                    <span className={cn('w-3 shrink-0 font-mono font-semibold', statusClass(f.status))} aria-label={t(`changes.status.${f.status}` as MessageKey)}>
                      {f.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-text-primary">{name}</span>
                      {dir && <span className="ml-1.5 text-text-secondary">{dir}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-text-secondary">{rowCounts(f)}</span>
                  </button>
                )
              })}
            </div>
          ))}
          {status && !status.complete && status.files.length > 0 && (
            <p className="px-3 py-2 text-[11px] text-text-secondary" data-shared-changes-partial>
              {t('changes.truncated', { shown: status.files.length, total: status.total })}
            </p>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shared-diff={selected ? rowKey(selected) : ''}>
          {diffBody}
          {selected && res && !diffErr && !diff.done && (
            <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border px-3 py-1.5 text-xs text-text-secondary">
              {t('shareGuest.changes.partial')}
              <button
                type="button"
                data-shared-diff-more
                disabled={diffBusy}
                onClick={() => void readDiff(selected, diff)}
                className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card disabled:opacity-40"
              >
                {t('shareGuest.changes.loadMore')}
              </button>
            </div>
          )}
          {unstable && <p className="shrink-0 border-t border-border px-3 py-1.5 text-center text-xs text-text-secondary">{t('shareGuest.changes.unstable')}</p>}
        </div>
      </div>
    </div>
  )
}
