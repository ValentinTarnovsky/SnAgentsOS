/**
 * The interactive half of `.snagentsos.json` (E8-FR-24/25/27): the trust
 * dialog request (one global host renders it), then create or reload. The
 * hash is computed and stored by main; the renderer only decides.
 */
import { create } from 'zustand'
import type { RepoConfigReadRes } from '@shared/repo-config'
import { useAppStore } from '@/lib/store'
import { getPtyId } from '@/lib/ptyRegistry'
import { toast } from '@/lib/toast'
import type { TFn } from '@/i18n'
import { draftFromRepoConfig, trustDialogNeeded, trustItemsFor, type TrustItem } from './repoConfig'

export interface TrustRequest {
  /** Repo folder, shown in the dialog. */
  dir: string
  items: TrustItem[]
  /** "The file changed since last time" header. */
  changed: boolean
}

interface TrustState {
  request: (TrustRequest & { resolve: (ok: boolean) => void }) | null
  /** Workspace whose export dialog is open (E8-FR-26), null = closed. */
  exportWorkspaceId: string | null
}

export const useRepoConfigUi = create<TrustState>(() => ({ request: null, exportWorkspaceId: null }))

/** Show the trust dialog; resolves true on "Trust and open". A newer request cancels the older one. */
export function requestRepoTrust(req: TrustRequest): Promise<boolean> {
  useRepoConfigUi.getState().request?.resolve(false)
  return new Promise<boolean>((resolve) => {
    useRepoConfigUi.setState({ request: { ...req, resolve } })
  })
}

/** The dialog's answer. */
export function answerRepoTrust(ok: boolean): void {
  const req = useRepoConfigUi.getState().request
  if (!req) return
  useRepoConfigUi.setState({ request: null })
  req.resolve(ok)
}

export function openRepoExport(workspaceId: string | null): void {
  useRepoConfigUi.setState({ exportWorkspaceId: workspaceId })
}

type RepoApi = Window['snApi']['repoConfig']
type Ask = (req: TrustRequest) => Promise<boolean>

export type TrustOutcome = { ok: true; res: RepoConfigReadRes } | { ok: false; error?: string }

function consoleCount(res: RepoConfigReadRes): number {
  const cfg = res.config
  return cfg ? cfg.consoles.length + (cfg.setup ? 1 : 0) : 0
}

/**
 * E8-FR-24: the dialog when the file is executable and not approved (or a
 * profile was picked by hand), then main's approval. When the file moved on
 * between the read and the answer main says `changed`: read it again and ask
 * again, under "The file changed since last time".
 */
export async function confirmRepoTrust(
  dir: string,
  first: RepoConfigReadRes,
  profileName: string | undefined,
  deps: { api?: RepoApi; ask?: Ask } = {},
): Promise<TrustOutcome> {
  const api = deps.api ?? window.snApi.repoConfig
  const ask = deps.ask ?? requestRepoTrust
  let res = first
  let changed = !!first.changedSinceTrust
  for (let round = 0; round < 3; round++) {
    if (res.status !== 'ok' || !res.config || !res.sha256) return { ok: false, error: res.error ?? res.status }
    const need = trustDialogNeeded(res, profileName)
    if (!need.dialog) return { ok: true, res }
    const items = trustItemsFor(res.config, profileName, consoleCount(res))
    if (!(await ask({ dir, items, changed }))) return { ok: false }
    if (!need.store) return { ok: true, res }
    const answer = await api.trust({ dir, sha256: res.sha256 })
    if (answer.ok) return { ok: true, res: { ...res, trusted: true, changedSinceTrust: false } }
    if (!answer.changed) return { ok: false, error: answer.error }
    res = await api.read(dir)
    changed = true
  }
  return { ok: false, error: 'changed' }
}

function defaultShell(): string | undefined {
  const p = window.snApi.platform
  const shells = useAppStore.getState().settings.defaultShell
  return p === 'win32' || p === 'darwin' || p === 'linux' ? shells[p] : undefined
}

/**
 * "Use repo configuration" (E8-FR-25): read again (cwds re-checked with
 * realpath at create time), trust, then create the workspace. Returns true
 * when it was created.
 */
export async function openFromRepo(dir: string, profileId: string, t: TFn): Promise<boolean> {
  const api = window.snApi.repoConfig
  const fresh = await api.read(dir)
  if (fresh.status !== 'ok') {
    toast.error(t('repo.card.invalid'), { body: fresh.error })
    return false
  }
  const s0 = useAppStore.getState()
  const profile = profileId ? s0.connections.find((c) => c.id === profileId) : undefined
  const trust = await confirmRepoTrust(dir, fresh, profile?.name)
  if (!trust.ok) {
    if (trust.error) toast.error(t('repo.card.invalid'), { body: trust.error })
    return false
  }
  const s = useAppStore.getState()
  const d = draftFromRepoConfig({
    dir,
    res: trust.res,
    presets: s.presets,
    connections: s.connections,
    profileId: profile ? profile.id : '',
    quickCount: s.quickCommands.length,
    shell: defaultShell(),
    platform: window.snApi.platform,
  })
  s.createWorkspaceFull(d.draft)
  if (d.skippedQuick > 0) toast.warning(t('repo.warn.quickSkipped', { count: d.skippedQuick }))
  return true
}

/**
 * "Reload from .snagentsos.json" (E8-FR-27): through the trust step, then the
 * grid, the consoles without a live pty and the repo's Quick Commands are
 * replaced. The profile follows the file (by name, when it exists here).
 */
export async function reloadFromRepo(workspaceId: string, t: TFn): Promise<boolean> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws || !ws.cwd) return false
  const api = window.snApi.repoConfig
  const res = await api.read(ws.cwd)
  if (res.status === 'none') {
    toast.error(t('repo.reload.none', { path: ws.cwd }))
    return false
  }
  if (res.status !== 'ok' || !res.config) {
    toast.error(t('repo.reload.failed', { error: res.error ?? res.status }))
    return false
  }
  const s0 = useAppStore.getState()
  const named = res.config.connectionProfile
  const profile = named ? s0.connections.find((c) => c.name === named) : undefined
  const trust = await confirmRepoTrust(ws.cwd, res, profile?.name)
  if (!trust.ok) {
    if (trust.error) toast.error(t('repo.reload.failed', { error: trust.error }))
    return false
  }
  const s = useAppStore.getState()
  const current = s.workspaces.find((w) => w.id === workspaceId)
  if (!current) return false
  const live = current.panes.filter((p) => !!getPtyId(p.id) && !(p.id in s.paneExit)).map((p) => p.id)
  const listed = new Set(current.repoConfig?.quickCommandIds ?? [])
  const d = draftFromRepoConfig({
    dir: current.cwd,
    res: trust.res,
    presets: s.presets,
    connections: s.connections,
    profileId: profile?.id ?? '',
    quickCount: s.quickCommands.filter((c) => !listed.has(c.id)).length,
    shell: defaultShell(),
    platform: window.snApi.platform,
  })
  const { setup: _noSetup, ...draft } = d.draft
  const r = s.reloadWorkspaceFromRepo(workspaceId, draft, live)
  toast.success(r.kept > 0 ? t('repo.reload.kept', { count: r.kept }) : t('repo.reload.done'))
  if (d.skippedQuick > 0) toast.warning(t('repo.warn.quickSkipped', { count: d.skippedQuick }))
  return true
}
