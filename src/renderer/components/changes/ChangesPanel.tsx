import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { LoaderCircle, RefreshCw, WrapText, X } from 'lucide-react'
import type { GitArea, GitChangesRes, GitDiffReply, GitFileEntry } from '@shared/git-types'
import type { Workspace } from '@shared/types'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/lib/store'
import { useGitStore } from '@/lib/gitStore'
import { refreshGit } from '@/lib/gitSync'
import { toast } from '@/lib/toast'
import { chipBranch } from '@/lib/gitChip'
import { insertPathToConsole } from '@/lib/insertPath'
import { closeChangesPanel } from '@/lib/changesPanel'
import { absRepoPath, loadWrap, PANEL_POLL_MS, panelKeyOf, panelTargets, rowKey, saveWrap, splitName, stepRow, visibleRows } from '@/lib/changes'
import { Tooltip } from '@/components/ui/Tooltip'
import { FileList, type RowActions } from './FileList'
import { DiffView, type DiffViewHandle } from './DiffView'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Changes panel (E7-FR-11..16): a read-only drawer over the active
 * workspace's grid with the target selector, the file list and the diff of
 * the selected file. While open, main polls its target every 3 s (focused
 * window); the list also reloads on every summary change. A refresh keeps the
 * selection, the collapsed sections and (for an unchanged diff) the scroll,
 * and never blanks the panel: the old content stays up with a 12 px spinner.
 */
export function ChangesPanel({ workspace, targetKey }: { workspace: Workspace; targetKey: string }) {
  const t = useT()
  const reduced = useReducedMotion()
  const api = window.snApi.git
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const summary = useGitStore((s) => s.summaries[targetKey])
  const gitError = useGitStore((s) => s.errors[targetKey])
  const allSummaries = useGitStore((s) => s.summaries)
  const setFiles = useGitStore((s) => s.setFiles)
  const openChanges = useGitStore((s) => s.openChanges)

  const [data, setData] = useState<GitChangesRes | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ path: string; area: GitArea } | null>(null)
  const [diff, setDiff] = useState<GitDiffReply | null>(null)
  const [forced, setForced] = useState<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<GitArea>>(new Set())
  const [wrap, setWrap] = useState(() => loadWrap(storage()))
  const rootRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<DiffViewHandle>(null)
  const listSeq = useRef(0)
  const diffSeq = useRef(0)
  const autoPicked = useRef(false)

  const targets = useMemo(() => panelTargets(workspace), [workspace])
  const selKey = selected ? rowKey(selected) : null

  // Main polls the open panel's target (FR-06e) for as long as it is mounted.
  useEffect(() => {
    api.setPanel(targetKey)
    return () => api.setPanel(null)
  }, [api, targetKey])

  // A new target starts clean.
  useEffect(() => {
    setData(null)
    setLoaded(false)
    setSelected(null)
    setDiff(null)
    setForced(new Set())
    autoPicked.current = false
  }, [targetKey])

  const load = useCallback(async () => {
    const seq = ++listSeq.current
    setLoading(true)
    try {
      const res = await api.status(targetKey)
      if (seq !== listSeq.current) return
      setData(res)
      setFiles(targetKey, res?.files ?? [])
    } catch {
      // Keep what is on screen; the next poll tries again.
    } finally {
      if (seq === listSeq.current) {
        setLoading(false)
        setLoaded(true)
      }
    }
  }, [api, targetKey, setFiles])

  // First load, every summary change main pushes, and the panel poll while the window has focus.
  useEffect(() => {
    void load()
  }, [load, summary])
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hasFocus()) void load()
    }, PANEL_POLL_MS)
    return () => window.clearInterval(id)
  }, [load])

  // Focus lands in the panel when it opens, so its keys work right away.
  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true })))
    return () => cancelAnimationFrame(raf)
  }, [])

  const files = data?.files ?? null
  const listed = useMemo(() => (files && selected ? files.find((f) => f.path === selected.path && f.area === selected.area) ?? null : null), [files, selected])

  // Pick the first file once per target so the diff is not empty on open.
  useEffect(() => {
    if (autoPicked.current || !files) return
    autoPicked.current = true
    const first = visibleRows(files, collapsed)[0]
    if (first && !selected) setSelected({ path: first.path, area: first.area })
  }, [files, collapsed, selected])

  // Load the selected file's diff on every list refresh; an unchanged rev keeps the view (and its scroll).
  useEffect(() => {
    if (!selected || !files) return
    if (!listed) {
      setDiff({ error: 'gone' })
      return
    }
    const seq = ++diffSeq.current
    const force = forced.has(rowKey(selected))
    void api
      .fileDiff({ key: targetKey, path: selected.path, area: selected.area, force })
      .then((res) => {
        if (seq !== diffSeq.current) return
        setDiff((prev) => (prev && !('error' in prev) && !('error' in res) && prev.diffRev === res.diffRev && prev.path === res.path && prev.area === res.area && !!prev.tooLarge === !!res.tooLarge ? prev : res))
      })
      .catch(() => {
        if (seq === diffSeq.current) setDiff({ error: 'git_error' })
      })
  }, [api, targetKey, files, listed, selected, forced])

  const select = (f: GitFileEntry): void => {
    if (selected && selected.path === f.path && selected.area === f.area) return
    setDiff(null)
    setSelected({ path: f.path, area: f.area })
  }

  const repoRoot = data?.summary.repoRoot ?? summary?.repoRoot ?? ''
  const actions: RowActions = {
    absPath: (f) => absRepoPath(repoRoot, f.path),
    copyRelative: (f) => {
      window.snApi.clipboard.writeText(f.path)
      toast.success(t('changes.copied'), { dedupeKey: 'changes-copy' })
    },
    copyAbsolute: (f) => {
      window.snApi.clipboard.writeText(absRepoPath(repoRoot, f.path))
      toast.success(t('changes.copied'), { dedupeKey: 'changes-copy' })
    },
    open: (f) => {
      void api.openFile({ key: targetKey, path: f.path }).then((ok) => {
        if (!ok) toast.error(t('changes.openFailed'), { dedupeKey: 'changes-open' })
      })
    },
    reveal: (f) => {
      void api.openFile({ key: targetKey, path: f.path, reveal: true }).then((ok) => {
        if (!ok) toast.error(t('changes.openFailed'), { dedupeKey: 'changes-open' })
      })
    },
    insert: (f) => {
      const paneId = insertPathToConsole(absRepoPath(repoRoot, f.path))
      if (!paneId) {
        toast.error(t('changes.noConsole'), { dedupeKey: 'changes-insert' })
        return
      }
      const pane = useAppStore.getState().workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId)
      toast.success(t('changes.inserted', { pane: pane?.title ?? '' }), { dedupeKey: 'changes-insert' })
    },
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const k = panelKeyOf(e)
    if (!k) return
    // A native select keeps its own Esc (closing its dropdown); an open row menu closes first.
    if (k === 'close' && ((e.target as HTMLElement).tagName === 'SELECT' || document.querySelector('[role=menu]'))) return
    e.preventDefault()
    e.stopPropagation()
    if (k === 'close') closeChangesPanel()
    else if (k === 'nextHunk' || k === 'prevHunk') diffRef.current?.stepHunk(k === 'nextHunk' ? 1 : -1)
    else if (k === 'nextFile' || k === 'prevFile') {
      const next = stepRow(visibleRows(files ?? [], collapsed), selKey, k === 'nextFile' ? 1 : -1)
      if (next) select(next)
    } else if (k === 'wrap') {
      setWrap((w) => {
        saveWrap(storage(), !w)
        return !w
      })
    }
  }

  const toggleSection = (area: GitArea): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(area)) next.delete(area)
      else next.add(area)
      return next
    })

  const targetLabel = (key: string, paneTitle?: string): string => {
    const s = allSummaries[key]
    const branch = s ? chipBranch(s) : ''
    if (paneTitle === undefined) return branch ? t('changes.targetWorkspace', { branch }) : t('changes.targetWorkspaceBare')
    return t('changes.targetPane', { branch: branch || '?', pane: paneTitle })
  }

  const total = data ? data.summary.staged + data.summary.unstaged + data.summary.untracked + data.summary.conflicts : 0

  let listBody: ReactNode
  if (!workspace.cwd && targetKey.startsWith('ws:')) listBody = <Empty text={t('changes.noCwd')} />
  else if (!data && gitError === 'unsafe_repo') listBody = <Empty text={t('git.err.unsafe', { path: (workspace.cwd ?? '').replace(/\\/g, '/') })} />
  else if (!data && gitError) listBody = <Empty text={t(`changes.err.${gitError}`)} />
  else if (!data) listBody = <Empty text={loaded ? t('changes.err.not_repo') : t('changes.loading')} />
  else if (data.files.length === 0) listBody = <Empty text={t('changes.clean')} />
  else
    listBody = (
      <FileList
        files={data.files}
        total={total}
        truncated={data.summary.truncated}
        selected={selKey}
        collapsed={collapsed}
        onToggleSection={toggleSection}
        onSelect={select}
        actions={actions}
      />
    )

  let diffBody: ReactNode = null
  if (data && data.files.length > 0) {
    if (!selected) diffBody = <Empty text={t('changes.pickFile')} />
    else if (!diff) diffBody = null
    else if ('error' in diff) diffBody = <Empty text={diff.error === 'gone' || diff.error === 'denied' ? t('changes.gone') : t('changes.diffError')} />
    else if (diff.binary) diffBody = <Empty text={t('changes.binary')} />
    else if (diff.tooLarge)
      diffBody = (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-text-secondary" data-changes-toolarge>
          <span>{diff.tooLarge.lines > 0 ? t('changes.tooLarge', { lines: diff.tooLarge.lines }) : t('changes.tooLargeBytes', { size: Math.round(diff.tooLarge.bytes / 1024) })}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => selected && setForced((prev) => new Set(prev).add(rowKey(selected)))}
              className="rounded-btn border border-border bg-card px-2.5 py-1 text-text-primary hover:border-accent-violet/40"
              data-changes-force
            >
              {t('changes.showAnyway')}
            </button>
            <button
              type="button"
              onClick={() => listed && actions.reveal(listed)}
              className="rounded-btn border border-border bg-card px-2.5 py-1 text-text-primary hover:border-accent-violet/40"
            >
              {t('changes.showInFolder')}
            </button>
          </div>
        </div>
      )
    else if (diff.hunks.length === 0) diffBody = <Empty text={t('changes.emptyFile')} />
    else diffBody = <DiffView ref={diffRef} diff={diff} wrap={wrap} fontFamily={fontFamily} fontSize={12} />
  }

  const sel = selected ? splitName(selected.path) : null

  return (
    <motion.div
      ref={rootRef}
      tabIndex={-1}
      role="complementary"
      aria-label={t('changes.title')}
      onKeyDown={onKeyDown}
      initial={reduced ? false : { x: '100%' }}
      animate={{ x: 0 }}
      transition={{ duration: reduced ? 0 : 0.15, ease: 'easeOut' }}
      className="absolute inset-y-0 right-0 z-20 flex max-w-full flex-col border-l border-border bg-bg-primary shadow-[-12px_0_32px_-16px_rgba(0,0,0,0.7)] outline-none"
      style={{ width: 'clamp(420px, 45%, 900px)' }}
      data-changes-panel
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="shrink-0 text-sm font-medium text-text-primary">{t('changes.title')}</span>
        {targets.length > 1 ? (
          <select
            value={targetKey}
            onChange={(e) => openChanges(e.target.value)}
            aria-label={t('changes.target')}
            className="min-w-0 flex-1 truncate rounded-btn border border-border bg-card px-1.5 py-0.5 text-xs text-text-primary"
            data-changes-target
          >
            {targets.map((tg) => (
              <option key={tg.key} value={tg.key}>
                {targetLabel(tg.key, tg.paneTitle)}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" data-changes-target>
            {targetLabel(targetKey, targets.find((x) => x.key === targetKey)?.paneTitle)}
          </span>
        )}
        <span className="flex w-3 shrink-0 justify-center" aria-hidden>
          {loading && <LoaderCircle size={12} className="animate-spin text-text-secondary" data-changes-spinner />}
        </span>
        <Tooltip label={t('changes.refresh')} side="bottom">
          <button
            type="button"
            onClick={() => {
              refreshGit([targetKey])
              void load()
            }}
            aria-label={t('changes.refresh')}
            className="rounded-btn p-1 text-text-secondary hover:bg-card hover:text-text-primary"
            data-changes-refresh
          >
            <RefreshCw size={14} />
          </button>
        </Tooltip>
        <Tooltip label={<span className="max-w-[260px]">{t('changes.wrap')}<br />{t('changes.keysHint')}</span>} side="bottom">
          <button
            type="button"
            onClick={() =>
              setWrap((w) => {
                saveWrap(storage(), !w)
                return !w
              })
            }
            aria-label={t('changes.wrap')}
            aria-pressed={wrap}
            className={cn('rounded-btn p-1 hover:bg-card', wrap ? 'text-accent-violet' : 'text-text-secondary hover:text-text-primary')}
            data-changes-wrap
          >
            <WrapText size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('changes.close')} side="bottom">
          <button type="button" onClick={closeChangesPanel} aria-label={t('changes.close')} className="rounded-btn p-1 text-text-secondary hover:bg-card hover:text-text-primary" data-changes-close>
            <X size={15} />
          </button>
        </Tooltip>
      </div>

      <div className={cn('flex min-h-0 shrink-0 flex-col border-b border-border', data && data.files.length > 0 ? 'max-h-[38%]' : 'flex-1')}>{listBody}</div>

      {data && data.files.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col">
          {sel && selected && (
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs" data-changes-file-header>
              <span className="min-w-0 truncate font-semibold text-text-primary">
                {listed?.oldPath ? `${listed.oldPath} -> ${selected.path}` : selected.path}
              </span>
              <span className="shrink-0 text-text-secondary">{t(`changes.section.${selected.area}`)}</span>
            </div>
          )}
          {diffBody}
        </div>
      )}
    </motion.div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="flex flex-1 items-center justify-center p-6 text-center text-xs text-text-secondary">{text}</p>
}
