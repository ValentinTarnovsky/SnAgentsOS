import { app, ipcMain, shell } from 'electron'
import { promises as fsp } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { CH } from '@shared/ipc-channels'
import type { ConfigFile } from '@shared/types'
import { gitRunner } from '../git/gitExec'
import { WorktreeManifest } from '../git/WorktreeManifest'
import { WorktreeService } from '../git/WorktreeService'
import { defaultElevation, type PathGuard } from '../migration/safeRemove'
import { dataDir } from '../paths'

export interface WorktreeIpcDeps {
  loadConfig: () => ConfigFile | null
  /** PtyManager.killPaneAndWait: the pane's shell must let go of the folder first. */
  killPane: (paneId: string) => Promise<void>
}

/** settings.worktreesRoot when it is an absolute path, else dataDir()/worktrees (E7-FR-28). */
export function worktreesRootOf(cfg: ConfigFile | null, fallback: string): string {
  const raw = (cfg?.settings as { worktreesRoot?: unknown } | undefined)?.worktreesRoot
  return typeof raw === 'string' && raw.trim() && isAbsolute(raw.trim()) ? raw.trim() : fallback
}

/**
 * Every pane of the saved config (any workspace) that runs in a worktree,
 * with its folder (app 2.7.0, A9): a delete is refused while another one is
 * on the folder. Renderer data, only ever compared, never acted on.
 */
export function worktreePanesOf(cfg: ConfigFile | null): Array<{ paneId: string; path: string }> {
  const out: Array<{ paneId: string; path: string }> = []
  for (const ws of cfg?.workspaces ?? []) {
    for (const p of ws.panes ?? []) {
      const path = p.worktree?.path
      if (typeof p.id === 'string' && typeof path === 'string' && path) out.push({ paneId: p.id, path })
    }
  }
  return out
}

/** What a worktree delete must never touch, on top of "strictly inside the worktree root". */
function removalGuard(): Omit<PathGuard, 'allowedRoots'> {
  const present = (list: Array<string | null | undefined>): string[] => list.filter((p): p is string => !!p)
  const safePath = (name: Parameters<typeof app.getPath>[0]): string | null => {
    try {
      return app.getPath(name)
    } catch {
      return null
    }
  }
  return {
    forbiddenExact: present([
      homedir(), tmpdir(), join(homedir(), '.claude'), safePath('appData'), safePath('desktop'), process.env.LOCALAPPDATA,
      ...defaultElevation().programFiles,
    ]),
    forbiddenTree: [],
    forbiddenContain: present([dataDir(), safePath('userData'), dirname(process.execPath), process.env.PORTABLE_EXECUTABLE_DIR, app.getAppPath()]),
  }
}

/**
 * Worktree per console (E7-FR-27..32, 36): `git:worktreeAdd` / `Remove`
 * (contract) and `Probe` / `Inspect` / `List` / `Reveal` (amendments). Every
 * payload is validated again in WorktreeService; the renderer only sends a
 * path, a slug and a pane id.
 */
export function registerWorktreeIpc(deps: WorktreeIpcDeps): WorktreeService {
  const defaultRoot = (): string => join(dataDir(), 'worktrees')
  const service = new WorktreeService({
    runner: gitRunner,
    manifest: new WorktreeManifest(join(dataDir(), 'worktrees.json')),
    root: () => worktreesRootOf(deps.loadConfig(), defaultRoot()),
    defaultRoot,
    guard: removalGuard,
    killPane: deps.killPane,
    worktreePanes: () => worktreePanesOf(deps.loadConfig()),
  })
  ipcMain.handle(CH.GIT_WORKTREE_ADD, (_e, req: unknown) => service.create(req))
  ipcMain.handle(CH.GIT_WORKTREE_REMOVE, (_e, req: unknown) => service.remove(req))
  ipcMain.handle(CH.GIT_WORKTREE_PROBE, (_e, p: { repoCwd?: unknown } | null) => service.probe(p?.repoCwd))
  ipcMain.handle(CH.GIT_WORKTREE_INSPECT, (_e, req: unknown) => service.inspect(req))
  ipcMain.handle(CH.GIT_WORKTREE_LIST, () => service.list())
  ipcMain.handle(CH.GIT_WORKTREE_REVEAL, async (_e, p: { path?: unknown } | null): Promise<boolean> => {
    const path = p?.path
    if (!service.isManaged(path)) return false
    // Only ever a folder: openPath on a file would run it with its default app.
    try {
      if (!(await fsp.stat(path)).isDirectory()) return false
    } catch {
      return false
    }
    return (await shell.openPath(path)) === ''
  })
  return service
}
