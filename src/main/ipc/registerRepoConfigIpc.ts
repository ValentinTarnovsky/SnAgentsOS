import { ipcMain } from 'electron'
import { join } from 'path'
import { CH } from '@shared/ipc-channels'
import { REPO_CONFIG_FILE, type RepoConfigPreviewRes, type RepoConfigTrustRes } from '@shared/repo-config'
import { dataDir } from '../paths'
import { TrustStore } from '../repoConfig/TrustStore'
import { exportRepoConfig, readRepoConfig, repoConfigExists, serializeRepoConfig, validRepoDir } from '../repoConfig/repoConfig'

const SHA_RE = /^[0-9a-f]{64}$/

function req(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** The `repoConfig:*` handlers over one store; split out so tests drive them without Electron. */
export function repoConfigHandlers(trust: TrustStore) {
  return {
    read: (dir: unknown) => readRepoConfig(dir, trust),
    /**
     * The renderer decides, main verifies: the hash it approved must still be
     * the file's current one (E8-FR-24). Otherwise `changed` and the flow repeats.
     */
    trust: async (raw: unknown): Promise<RepoConfigTrustRes> => {
      const { dir, sha256 } = req(raw)
      if (!validRepoDir(dir) || typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return { ok: false, error: 'bad_request' }
      const now = await readRepoConfig(dir, null)
      if (now.status !== 'ok' || !now.sha256) return { ok: false, error: now.status }
      if (now.sha256 !== sha256) return { ok: false, changed: true }
      trust.set(dir, sha256)
      return { ok: true }
    },
    previewExport: async (raw: unknown): Promise<RepoConfigPreviewRes> => {
      const { dir, file } = req(raw)
      if (!validRepoDir(dir)) return { ok: false, error: 'dir' }
      const ser = serializeRepoConfig(file)
      if (!ser.ok) return { ok: false, error: ser.error }
      return { ok: true, json: ser.json, exists: await repoConfigExists(dir), path: join(dir, REPO_CONFIG_FILE) }
    },
    /** The exported content is trusted right away (E8-FR-26): opening it never asks. */
    export: async (raw: unknown) => {
      const { dir, file, overwrite } = req(raw)
      const res = await exportRepoConfig(dir, file, overwrite === true)
      if (res.ok && typeof dir === 'string') trust.set(dir, res.sha256)
      return res
    },
  }
}

/**
 * Per-repo `.snagentsos.json` channels (E8-FR-23..27): `repoConfig:read`,
 * `repoConfig:trust`, `repoConfig:previewExport` (amendment) and
 * `repoConfig:export`. The trust file `dataDir()/trusted-repos.json` is
 * resolved on first use, after the legacy migration.
 */
export function registerRepoConfigIpc(): TrustStore {
  const trust = new TrustStore({ file: () => join(dataDir(), 'trusted-repos.json') })
  const h = repoConfigHandlers(trust)
  ipcMain.handle(CH.REPO_CONFIG_READ, (_e, dir: unknown) => h.read(dir))
  ipcMain.handle(CH.REPO_CONFIG_TRUST, (_e, r: unknown) => h.trust(r))
  ipcMain.handle(CH.REPO_CONFIG_PREVIEW_EXPORT, (_e, r: unknown) => h.previewExport(r))
  ipcMain.handle(CH.REPO_CONFIG_EXPORT, (_e, r: unknown) => h.export(r))
  return trust
}
