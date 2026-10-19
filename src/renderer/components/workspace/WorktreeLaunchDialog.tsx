import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitBranch, Loader2 } from 'lucide-react'
import type { WorktreeAddRes, WorktreeProbeRes } from '@shared/worktree-types'
import { useWorktreeStore, type WorktreeLaunchRequest } from '@/lib/worktreeStore'
import { applyCreatedWorktree, defaultSlug, isValidSlug } from '@/lib/worktrees'
import { focusPane, setFocusedPane } from '@/lib/focus'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'

/** Mounted once (App); shows while a launch request is open. */
export function WorktreeLaunchDialog() {
  const req = useWorktreeStore((s) => s.launch)
  if (!req) return null
  // Keyed so every request starts from a fresh draft.
  return <LaunchDialog key={`${req.workspaceId}|${req.repoCwd}|${req.template.name}|${req.replacePaneId ?? ''}`} req={req} />
}

type ErrorRes = Exclude<WorktreeAddRes, { ok: true }>

/**
 * "New console in an isolated worktree" (E7-FR-27): branch `sn/` + an
 * editable slug, the read-only base, the .env copy (on) and the node_modules
 * junction (off, with its warning). Enter creates; the button spins while git
 * runs (main's timeout is 120 s). Also "Recreate on a new branch" of FR-36.
 */
function LaunchDialog({ req }: { req: WorktreeLaunchRequest }) {
  const t = useT()
  const close = useWorktreeStore((s) => s.closeLaunch)
  const [slug, setSlug] = useState(() => defaultSlug(req.template.name))
  const [copyEnv, setCopyEnv] = useState(true)
  const [linkNodeModules, setLinkNodeModules] = useState(false)
  const [probe, setProbe] = useState<WorktreeProbeRes | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorRes | null>(null)

  useEffect(() => {
    let live = true
    window.snApi.git
      .worktreeProbe(req.repoCwd)
      .then((r) => live && setProbe(r))
      .catch(() => live && setProbe({ ok: false, error: 'git_error' }))
    return () => {
      live = false
    }
  }, [req.repoCwd])

  const slugOk = isValidSlug(slug)
  const canCreate = slugOk && probe?.ok === true && !busy

  const cancel = (): void => {
    if (!busy) close()
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

  const create = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    let res: WorktreeAddRes
    try {
      res = await window.snApi.git.worktreeAdd({ repoCwd: req.repoCwd, slug, copyEnv, linkNodeModules })
    } catch (e) {
      res = { ok: false, error: 'git_error', detail: String((e as Error)?.message ?? e) }
    }
    setBusy(false)
    if (!res.ok) {
      setError(res)
      return
    }
    const paneId = applyCreatedWorktree(req, res.worktree)
    close()
    if (paneId) {
      setFocusedPane(paneId, req.workspaceId)
      requestAnimationFrame(() => focusPane(paneId))
    }
  }

  const probeText = !probe
    ? t('worktree.launch.checking')
    : probe.ok
      ? `HEAD (${probe.headShort})`
      : t(probe.error === 'not_repo' ? 'worktree.notRepo' : probe.error === 'unborn' ? 'worktree.unborn' : 'worktree.err.git_error', { detail: 'rev-parse' })
  const errorText = error ? t(`worktree.err.${error.error}` as MessageKey, { branch: `sn/${slug}`, detail: error.detail ?? '' }) : null

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6" data-worktree-launch>
      <div className="absolute inset-0 bg-black/60" onClick={cancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-launch-title"
        className="relative z-10 w-full max-w-md overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="space-y-4 p-5">
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-accent-violet" />
            <h2 id="worktree-launch-title" className="text-sm font-semibold text-text-primary">
              {req.replacePaneId ? t('worktree.launch.recreateTitle') : t('worktree.launch.title')}
            </h2>
          </div>
          <p className="-mt-1 truncate text-xs text-text-secondary">{req.template.name}</p>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{t('worktree.launch.branch')}</span>
            <div
              className={cn(
                'flex items-center rounded-btn border bg-bg-primary px-3 font-mono text-sm',
                slugOk ? 'border-border focus-within:border-accent-violet/60' : 'border-state-error/70',
              )}
            >
              <span className="shrink-0 text-text-secondary">sn/</span>
              <input
                autoFocus
                data-worktree-slug
                value={slug}
                maxLength={60}
                spellCheck={false}
                onChange={(e) => setSlug(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void create()
                  }
                }}
                aria-invalid={!slugOk}
                className="min-w-0 flex-1 bg-transparent py-2 text-text-primary outline-none"
              />
            </div>
            <span className={cn('block text-[11px]', slugOk ? 'text-text-secondary/80' : 'text-state-error')}>{t('worktree.launch.slugHint')}</span>
          </label>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{t('worktree.launch.base')}</span>
            <p
              data-worktree-base
              className={cn('rounded-btn border border-border bg-bg-secondary/40 px-3 py-2 font-mono text-sm', probe && !probe.ok ? 'text-state-error' : 'text-text-primary')}
            >
              {probeText}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" data-worktree-copy-env checked={copyEnv} onChange={(e) => setCopyEnv(e.target.checked)} className="accent-[var(--color-accent-violet)]" />
            {t('worktree.launch.copyEnv')}
          </label>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                data-worktree-link-nm
                checked={linkNodeModules}
                onChange={(e) => setLinkNodeModules(e.target.checked)}
                className="accent-[var(--color-accent-violet)]"
              />
              {t('worktree.launch.linkNodeModules')}
            </label>
            {linkNodeModules && (
              <p data-worktree-nm-warn className="pl-6 text-xs text-state-action">
                {t('worktree.launch.nodeModulesWarn')}
              </p>
            )}
          </div>

          <p className="text-xs text-text-secondary/80">{t('worktree.launch.uncommitted')}</p>
          {errorText && (
            <p data-worktree-error role="alert" className="break-words rounded-btn border border-state-error/40 bg-state-error/10 px-3 py-2 text-xs text-state-error">
              {errorText}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            onClick={cancel}
            disabled={busy}
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            data-worktree-create
            onClick={() => void create()}
            disabled={!canCreate}
            className="flex items-center gap-1.5 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? t('worktree.launch.creating') : t('worktree.launch.create')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
