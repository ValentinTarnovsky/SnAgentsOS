import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { toast } from '@/lib/toast'
import { Modal } from '@/components/common/Modal'
import { repoConfigFromWorkspace, type RepoExport } from '@/lib/repoConfig'
import { openRepoExport, useRepoConfigUi } from '@/lib/repoConfigFlow'

type Preview =
  | { kind: 'loading' }
  | { kind: 'ready'; json: string; exists: boolean; exp: RepoExport }
  | { kind: 'error'; error: string }

/**
 * "Export as .snagentsos.json" (E8-FR-26): the exact JSON to write (read
 * only), the secrets reminder and Write / Replace. Nothing is written before
 * the button; the written content is trusted by main right away.
 */
export function ExportRepoConfigDialog() {
  const t = useT()
  const wsId = useRepoConfigUi((s) => s.exportWorkspaceId)
  const ws = useAppStore((s) => (wsId ? s.workspaces.find((w) => w.id === wsId) : undefined))
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' })
  const [writing, setWriting] = useState(false)

  useEffect(() => {
    if (!wsId) return
    const s = useAppStore.getState()
    const target = s.workspaces.find((w) => w.id === wsId)
    if (!target || !target.cwd) {
      setPreview({ kind: 'error', error: t('repo.export.noFolder') })
      return
    }
    setPreview({ kind: 'loading' })
    let live = true
    const exp = repoConfigFromWorkspace(target, s.presets, s.connections, s.quickCommands, window.snApi.platform)
    window.snApi.repoConfig
      .previewExport({ dir: target.cwd, file: exp.file })
      .then((r) => {
        if (!live) return
        setPreview(r.ok ? { kind: 'ready', json: r.json, exists: r.exists, exp } : { kind: 'error', error: r.error })
      })
      .catch((err) => {
        if (live) setPreview({ kind: 'error', error: String(err) })
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])

  const close = (): void => openRepoExport(null)
  if (!wsId || !ws) return null

  const write = async (): Promise<void> => {
    if (preview.kind !== 'ready' || writing) return
    setWriting(true)
    try {
      const r = await window.snApi.repoConfig.export({ dir: ws.cwd, file: preview.exp.file, overwrite: preview.exists })
      if (r.ok) {
        // The workspace now comes from this file: "Reload" shows, and its
        // Quick Commands become the repo's (E8-FR-27).
        useAppStore.getState().setWorkspaceRepoConfig(ws.id, { sha256: r.sha256, appliedAt: Date.now(), quickCommandIds: preview.exp.quickCommandIds })
        toast.success(t('repo.export.done', { path: r.path }))
        close()
      } else {
        toast.error(t('repo.export.failed', { error: r.detail ?? r.error }))
      }
    } catch (err) {
      toast.error(t('repo.export.failed', { error: String(err) }))
    } finally {
      setWriting(false)
    }
  }

  return (
    <Modal open onClose={close} title={t('repo.export.title')} className="max-w-2xl">
      <div data-repo-export className="space-y-3 px-5 py-4 text-sm">
        <p data-repo-export-secrets className="flex items-start gap-1.5 text-xs text-amber-400">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          {t('repo.export.secrets')}
        </p>
        {preview.kind === 'ready' && preview.exp.warnings.length > 0 && (
          <ul data-repo-export-warnings className="space-y-0.5 text-xs text-amber-400">
            {preview.exp.warnings.map((w, i) => (
              <li key={i}>{t(w.key, w.vars)}</li>
            ))}
          </ul>
        )}
        {preview.kind === 'loading' && <p className="text-xs text-text-secondary">{t('repo.export.loading')}</p>}
        {preview.kind === 'error' && <p data-repo-export-error className="break-all text-xs text-red-400">{preview.error}</p>}
        {preview.kind === 'ready' && (
          <pre
            data-repo-export-json
            className="max-h-[50vh] overflow-auto whitespace-pre rounded-btn border border-border bg-bg-primary p-3 font-mono text-xs text-text-primary"
          >
            {preview.json}
          </pre>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
        <button onClick={close} className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card">
          {t('common.cancel')}
        </button>
        <button
          data-repo-export-write
          disabled={preview.kind !== 'ready' || writing}
          onClick={() => void write()}
          className="rounded-btn bg-accent-violet px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-50"
        >
          {preview.kind === 'ready' && preview.exists ? t('repo.export.replace') : t('repo.export.write')}
        </button>
      </div>
    </Modal>
  )
}
