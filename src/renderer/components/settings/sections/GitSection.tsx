import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, GitBranch, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { paneWorktreeOf, type WorktreeListEntry } from '@shared/worktree-types'
import { useAppStore } from '@/lib/store'
import { useGitStore } from '@/lib/gitStore'
import { gitChipEnabled } from '@/lib/gitChip'
import { useWorktreeStore } from '@/lib/worktreeStore'
import { orphanWorktrees } from '@/lib/worktrees'
import { useT } from '@/i18n'
import { SettingRow, ToggleRow } from '../ui'

/**
 * Settings > Git (E7-FR-10): the settings.gitChip switch and which git the app
 * found. Poll interval, focus refresh and the untracked budget are fixed
 * constants with no config key (shared contracts), so they are only described.
 * Also the worktree root (settings.worktreesRoot, E7-FR-28) and the orphaned
 * worktrees no console uses (E7-FR-31).
 */
export function GitSection() {
  const t = useT()
  const chipOn = useAppStore((s) => gitChipEnabled(s.settings))
  const updateSettings = useAppStore((s) => s.updateSettings)
  const info = useGitStore((s) => s.info)
  const loadInfo = useGitStore((s) => s.loadInfo)

  useEffect(() => {
    if (!info) void loadInfo()
  }, [info, loadInfo])

  const setChip = (v: boolean): void => updateSettings({ gitChip: v })

  let diag: string
  let bad = false
  if (!info) diag = t('settings.git.checking')
  else if (!info.available) {
    diag = t('settings.git.missing')
    bad = true
  } else if (info.tooOld) {
    diag = t('settings.git.old', { version: info.version ?? '?' })
    bad = true
  } else diag = info.path ? t('settings.git.found', { version: info.version ?? '?', path: info.path }) : t('settings.git.foundNoPath', { version: info.version ?? '?' })

  return (
    <div className="space-y-6">
      <ToggleRow searchId="git.chip" checked={chipOn} onChange={setChip} title={t('settings.git.chip')} description={t('settings.git.chipHint')} />
      <SettingRow searchId="git.diag" title={t('settings.git.diag')} description={t('settings.git.refreshHint')}>
        <div className="flex items-center gap-3">
          <p data-git-diag className={bad ? 'min-w-0 break-all text-xs text-state-error' : 'min-w-0 break-all font-mono text-xs text-text-primary'}>
            {diag}
          </p>
          <button
            type="button"
            onClick={() => void loadInfo(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
          >
            <RefreshCw size={13} className="text-accent-violet" />
            {t('settings.git.recheck')}
          </button>
        </div>
      </SettingRow>
      <WorktreesRootRow />
      <OrphanWorktrees />
    </div>
  )
}

/** settings.worktreesRoot: empty = dataDir()/worktrees. Saved on blur, Enter or Browse. */
function WorktreesRootRow() {
  const t = useT()
  const root = useAppStore((s) => s.settings.worktreesRoot ?? '')
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [draft, setDraft] = useState(root)
  useEffect(() => setDraft(root), [root])
  const commit = (v: string): void => {
    const next = v.trim()
    if (next !== root) updateSettings({ worktreesRoot: next })
  }
  const browse = async (): Promise<void> => {
    const dir = await window.snApi.dialog.openDirectory()
    if (dir) {
      setDraft(dir)
      commit(dir)
    }
  }
  return (
    <SettingRow searchId="git.worktreesRoot" title={t('settings.git.worktreesRoot')} description={t('settings.git.worktreesRootHint')}>
      <div className="flex items-center gap-2">
        <input
          data-worktrees-root
          value={draft}
          spellCheck={false}
          placeholder={t('settings.git.worktreesRootPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(draft)
          }}
          className="min-w-0 flex-1 rounded-btn border border-border bg-bg-primary px-3 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent-violet/60"
        />
        <button
          type="button"
          onClick={() => void browse()}
          className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
        >
          <FolderOpen size={13} className="text-accent-violet" />
          {t('common.browse')}
        </button>
      </div>
    </SettingRow>
  )
}

/**
 * Worktrees that no console references (FR-31): manifest entries plus the
 * folders main found under the roots. [Open a console here] adds a shell in
 * the active workspace; [Delete] goes through the same check as closing a
 * worktree console (FR-30). Deleting a workspace leaves its worktrees here.
 */
function OrphanWorktrees() {
  const t = useT()
  const workspaces = useAppStore((s) => s.workspaces)
  const activeId = useAppStore((s) => s.activeWorkspaceId)
  const deleting = useWorktreeStore((s) => s.close != null)
  const [entries, setEntries] = useState<WorktreeListEntry[] | null>(null)

  const load = useCallback(() => {
    Promise.resolve()
      .then(() => window.snApi.git.worktreeList())
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]))
  }, [])
  // Again after the delete dialog closes (deleted or not).
  useEffect(() => {
    if (!deleting) load()
  }, [deleting, load])

  const orphans = entries ? orphanWorktrees(entries, workspaces) : null

  const openHere = (e: WorktreeListEntry): void => {
    const wt = paneWorktreeOf(e)
    if (!wt || !activeId) return
    useAppStore.getState().addPane(activeId, { type: 'shell', title: wt.branch.replace(/^sn\//, ''), cwd: wt.path, worktree: wt })
  }
  const remove = (e: WorktreeListEntry): void => {
    useWorktreeStore.getState().openClose({ path: e.path, branch: e.branch, ...(e.base ? { base: e.base } : {}) })
  }

  return (
    <SettingRow searchId="git.worktrees" title={t('settings.git.worktrees')} description={t('settings.git.worktreesHint')}>
      <div className="space-y-2">
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
        >
          <RefreshCw size={13} className="text-accent-violet" />
          {t('settings.git.worktreesRefresh')}
        </button>
        {!orphans ? (
          <p className="text-xs text-text-secondary">{t('settings.git.worktreesLoading')}</p>
        ) : orphans.length === 0 ? (
          <p data-worktrees-empty className="text-xs text-text-secondary">{t('settings.git.worktreesEmpty')}</p>
        ) : (
          <ul className="space-y-1.5" data-worktrees-orphans>
            {orphans.map((e) => {
              const canOpen = !!activeId && e.exists && paneWorktreeOf(e) != null
              const status = !e.managed
                ? t('settings.git.worktreeUnmanaged')
                : !e.exists
                  ? t('settings.git.worktreeGone')
                  : e.dirty
                    ? t('settings.git.worktreeDirty')
                    : t('settings.git.worktreeClean')
              return (
                <li key={e.path} data-worktree-orphan={e.branch} className="flex min-w-0 items-center gap-2 rounded-btn border border-border bg-bg-primary px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-text-primary">
                      <GitBranch size={12} className="shrink-0 text-accent-violet" />
                      <span className="truncate">{e.branch}</span>
                      <span className={e.dirty || !e.exists ? 'shrink-0 font-sans text-[11px] text-state-action' : 'shrink-0 font-sans text-[11px] text-text-secondary'}>
                        {e.repoName} · {status}
                      </span>
                    </p>
                    <p className="truncate font-mono text-[11px] text-text-secondary" title={e.path}>
                      {e.path}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!canOpen}
                    title={!activeId ? t('settings.git.worktreeNoWorkspace') : undefined}
                    onClick={() => openHere(e)}
                    className="flex shrink-0 items-center gap-1 rounded-btn border border-border bg-card px-2 py-1 text-xs text-text-primary transition-colors hover:border-accent-violet/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={12} />
                    {t('settings.git.worktreeOpen')}
                  </button>
                  <button
                    type="button"
                    data-worktree-orphan-delete
                    disabled={!e.managed}
                    onClick={() => remove(e)}
                    className="flex shrink-0 items-center gap-1 rounded-btn border border-red-400/40 px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                    {t('settings.git.worktreeDelete')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </SettingRow>
  )
}
