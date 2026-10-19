import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileCode2, XCircle } from 'lucide-react'
import type { RepoConfigReadRes } from '@shared/repo-config'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { draftFromRepoConfig, repoSummary } from '@/lib/repoConfig'
import { openFromRepo } from '@/lib/repoConfigFlow'

/** Wait after the last keystroke before reading the folder's file. */
const READ_DEBOUNCE_MS = 300

interface RepoConfigCardProps {
  /** Folder typed or picked in the composer / wizard. */
  cwd: string
  /** The workspace was created from the file: close the flow. */
  onApplied: () => void
}

/**
 * "This repo brings a configuration" (E8-FR-23): shown under the folder of
 * the composer and of the wizard's first step when it has a valid (or a
 * broken) `.snagentsos.json`. "Use repo configuration" goes through the trust
 * dialog (E8-FR-24) and creates the workspace (E8-FR-25).
 */
export function RepoConfigCard({ cwd, onApplied }: RepoConfigCardProps) {
  const t = useT()
  const presets = useAppStore((s) => s.presets)
  const connections = useAppStore((s) => s.connections)
  const quickCount = useAppStore((s) => s.quickCommands.length)
  const shell = useAppStore((s) => {
    const p = window.snApi.platform
    return p === 'win32' || p === 'darwin' || p === 'linux' ? s.settings.defaultShell[p] : undefined
  })
  const [res, setRes] = useState<{ dir: string; res: RepoConfigReadRes } | null>(null)
  const [ignored, setIgnored] = useState<string | null>(null)
  const [profileId, setProfileId] = useState('')
  const [busy, setBusy] = useState(false)

  const dir = cwd.trim()
  useEffect(() => {
    if (!dir) {
      setRes(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => window.snApi.repoConfig.read(dir))
        .then((r) => {
          if (!live) return
          setRes({ dir, res: r })
          // The file's profile is preselected when it exists here (E8-FR-23).
          const named = r.config?.connectionProfile
          setProfileId(named ? (useAppStore.getState().connections.find((c) => c.name === named)?.id ?? '') : '')
        })
        .catch(() => {
          if (live) setRes(null)
        })
    }, READ_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [dir])

  const current = res && res.dir === dir ? res.res : null
  const preview = useMemo(() => {
    if (!current || current.status !== 'ok' || !current.config) return null
    return draftFromRepoConfig({ dir, res: current, presets, connections, profileId, quickCount, shell, platform: window.snApi.platform })
  }, [current, dir, presets, connections, profileId, quickCount, shell])

  if (!current || current.status === 'none' || ignored === dir) return null

  if (current.status !== 'ok' || !current.config || !preview) {
    return (
      <div data-repo-card="error" className="rounded-btn border border-red-400/40 bg-red-400/5 px-3 py-2.5 text-xs">
        <p className="flex items-center gap-1.5 font-medium text-red-400">
          <XCircle size={13} className="shrink-0" />
          {current.status === 'too_large' ? t('repo.card.tooLarge') : t('repo.card.invalid')}
        </p>
        {current.error && <p data-repo-card-error className="mt-1 break-all font-mono text-[11px] text-text-secondary">{current.error}</p>}
      </div>
    )
  }

  const cfg = current.config
  const sum = repoSummary(cfg)
  const named = !!cfg.connectionProfile
  const use = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (await openFromRepo(dir, profileId, t)) onApplied()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-repo-card="ok" className="rounded-btn border border-accent-violet/40 bg-accent-violet/5 px-3 py-2.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-text-primary">
        <FileCode2 size={13} className="shrink-0 text-accent-violet" />
        {t('repo.card.title')}
      </p>
      <p data-repo-card-summary className="mt-1 break-words text-text-secondary">
        {t('repo.card.summary', { count: sum.count, titles: sum.titles, grid: sum.grid })}
        {sum.setup !== null && <span className="font-mono">{`, ${t('repo.card.setup', { command: sum.setup })}`}</span>}
      </p>
      {(named || connections.length > 0) && (
        <label className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-text-secondary">{t('repo.card.profile')}</span>
          <select
            data-repo-card-profile
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            className={cn(
              'h-7 min-w-0 flex-1 rounded-btn border bg-bg-primary px-2 text-xs text-text-primary outline-none',
              named || profileId ? 'border-amber-400/70' : 'border-border',
            )}
          >
            <option value="" className="bg-card">{t('wizard.connectionNone')}</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id} className="bg-card">{c.name}</option>
            ))}
          </select>
        </label>
      )}
      {preview.warnings.length > 0 && (
        <ul data-repo-card-warnings className="mt-2 space-y-0.5 text-amber-400">
          {preview.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 break-all">
              <AlertTriangle size={12} className="mt-px shrink-0" />
              <span>{t(w.key, w.vars)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          data-repo-card-ignore
          onClick={() => setIgnored(dir)}
          className="rounded-btn px-2.5 py-1 text-text-secondary transition-colors hover:text-text-primary"
        >
          {t('repo.card.ignore')}
        </button>
        <button
          type="button"
          data-repo-card-use
          disabled={busy}
          onClick={() => void use()}
          className="rounded-btn bg-accent-violet px-3 py-1 font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
        >
          {t('repo.card.use')}
        </button>
      </div>
    </div>
  )
}
