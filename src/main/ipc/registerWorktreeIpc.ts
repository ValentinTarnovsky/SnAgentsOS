import { app, ipcMain, shell } from 'electron'
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
  })
  ipcMain.handle(CH.GIT_WORKTREE_ADD, (_e, req: unknown) => service.create(req))
  ipcMain.handle(CH.GIT_WORKTREE_REMOVE, (_e, req: unknown) => service.remove(req))
  ipcMain.handle(CH.GIT_WORKTREE_PROBE, (_e, p: { repoCwd?: unknown } | null) => service.probe(p?.repoCwd))
  ipcMain.handle(CH.GIT_WORKTREE_INSPECT, (_e, req: unknown) => service.inspect(req))
  ipcMain.handle(CH.GIT_WORKTREE_LIST, () => service.list())
  ipcMain.handle(CH.GIT_WORKTREE_REVEAL, async (_e, p: { path?: unknown } | null): Promise<boolean> => {
    const path = p?.path
    if (!service.isManaged(path)) return false
    return (await shell.openPath(path)) === ''
  })
  return service
}
