import { ipcMain, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { UsageRow, UsageSnapshot } from '@shared/ipc-contract'
import type { UsageSettings } from '@shared/types'
import { fetchClaudeRows } from '../usage/claude'
import { fetchCodexRows } from '../usage/codex'
import { computeCustomRows } from '../usage/custom'
import { fetchServiceStatus, type ServiceStatus } from '../usage/status'

interface UsageIpcHooks {
  getSender: () => WebContents | null
  /** Usage settings from the persisted config at startup (before the renderer connects). */
  getInitialConfig: () => UsageSettings | null
}

const DEFAULTS: UsageSettings = {
  enabled: true,
  claudeIntervalMs: 60000,
  codexIntervalMs: 10000,
  refreshOnFocus: true,
  showStatus: true,
  rows: {
    claude5h: true,
    claude7d: true,
    claudeOpus7d: false,
    claudeSonnet7d: false,
    codex5h: true,
    codex7d: true,
  },
  custom: [],
}

// The Claude endpoint is remote (don't hammer it); Codex is a cheap local read.
const MIN_CLAUDE_MS = 30000
const MIN_CODEX_MS = 3000

function normalize(c: UsageSettings | null): UsageSettings {
  const merged = { ...DEFAULTS, ...(c ?? {}) }
  return {
    ...merged,
    claudeIntervalMs: Math.max(MIN_CLAUDE_MS, merged.claudeIntervalMs || DEFAULTS.claudeIntervalMs),
    codexIntervalMs: Math.max(MIN_CODEX_MS, merged.codexIntervalMs || DEFAULTS.codexIntervalMs),
    rows: { ...DEFAULTS.rows, ...(c?.rows ?? {}) },
    custom: Array.isArray(c?.custom) ? c.custom : [],
  }
}

/**
 * Usage-bars IPC. Owns two pollers in the main process:
 *  - Claude (remote OAuth endpoint) + custom-model parsing + service status, on
 *    `claudeIntervalMs`.
 *  - Codex (local rollout file), on `codexIntervalMs`.
 * Each tick refreshes its own cache and pushes a merged `UsageSnapshot` on
 * `usage:update`. Tokens/cookies never leave the main process; only computed
 * percentages and labels are sent.
 */
export function registerUsageIpc(hooks: UsageIpcHooks): void {
  const { getSender, getInitialConfig } = hooks
  let cfg = normalize(getInitialConfig())

  let claudeRows: UsageRow[] = []
  let codexRows: UsageRow[] = []
  let customRows: UsageRow[] = []
  let services: ServiceStatus | null = null
  let lastUpdated = 0

  let claudeTimer: NodeJS.Timeout | null = null
  let codexTimer: NodeJS.Timeout | null = null
  let claudeBusy = false
  let claudeErrorStreak = 0
  let configDebounce: NodeJS.Timeout | null = null

  // Consecutive all-error Claude polls tolerated before the UI shows "Error".
  const CLAUDE_ERROR_GRACE = 3
  const isAllError = (rows: UsageRow[]): boolean =>
    rows.length > 0 && rows.every((r) => r.status === 'error')

  const snapshot = (): UsageSnapshot => ({
    rows: [...claudeRows, ...codexRows, ...customRows],
    updatedAt: lastUpdated || Date.now(),
    services: cfg.showStatus ? services : null,
  })

  const emit = (): void => {
    const wc = getSender()
    if (wc && !wc.isDestroyed()) wc.send(CH.USAGE_UPDATE, snapshot())
  }

  async function refreshClaude(): Promise<void> {
    if (claudeBusy) return
    claudeBusy = true
    try {
      const fresh = await fetchClaudeRows(cfg.rows)
      // A lone transient failure (timeout/5xx/429) used to flip the bars to
      // "Error" for one cycle. Hold the last-good rows through a short grace
      // window so only a sustained outage surfaces. Expired/nodata aren't
      // all-error, so those legitimate states still show immediately.
      if (isAllError(fresh)) {
        claudeErrorStreak += 1
        const holdLastGood =
          claudeRows.length > 0 && !isAllError(claudeRows) && claudeErrorStreak < CLAUDE_ERROR_GRACE
        if (!holdLastGood) claudeRows = fresh
      } else {
        claudeErrorStreak = 0
        claudeRows = fresh
      }
      customRows = computeCustomRows(cfg.custom)
      services = cfg.showStatus ? await fetchServiceStatus() : null
      lastUpdated = Date.now()
    } catch (err) {
      console.error('[usage] claude refresh failed:', err)
    } finally {
      claudeBusy = false
    }
  }

  function refreshCodex(): void {
    try {
      codexRows = fetchCodexRows(cfg.rows)
      lastUpdated = Date.now()
    } catch (err) {
      console.error('[usage] codex refresh failed:', err)
    }
  }

  async function refreshAll(): Promise<void> {
    refreshCodex()
    await refreshClaude()
  }

  function schedule(): void {
    if (claudeTimer) {
      clearInterval(claudeTimer)
      claudeTimer = null
    }
    if (codexTimer) {
      clearInterval(codexTimer)
      codexTimer = null
    }
    if (!cfg.enabled) return
    claudeTimer = setInterval(() => {
      void refreshClaude().then(emit)
    }, cfg.claudeIntervalMs)
    codexTimer = setInterval(() => {
      refreshCodex()
      emit()
    }, cfg.codexIntervalMs)
  }

  // Initial kick + scheduling.
  if (cfg.enabled) {
    void refreshAll().then(emit)
  }
  schedule()

  ipcMain.handle(CH.USAGE_GET, async (): Promise<UsageSnapshot> => {
    if (lastUpdated === 0 && cfg.enabled) await refreshAll()
    return snapshot()
  })

  ipcMain.handle(CH.USAGE_REFRESH, async (): Promise<UsageSnapshot> => {
    await refreshAll()
    emit()
    return snapshot()
  })

  ipcMain.on(CH.USAGE_SET_CONFIG, (_e, next: UsageSettings) => {
    const prev = cfg
    cfg = normalize(next)
    const cadenceChanged =
      prev.enabled !== cfg.enabled ||
      prev.claudeIntervalMs !== cfg.claudeIntervalMs ||
      prev.codexIntervalMs !== cfg.codexIntervalMs
    if (cadenceChanged) schedule()
    if (!cfg.enabled) {
      emit()
      return
    }
    // Coalesce rapid toggles into a single full refresh so newly-enabled rows
    // (which the caches don't hold yet) are fetched.
    if (configDebounce) clearTimeout(configDebounce)
    configDebounce = setTimeout(() => {
      void refreshAll().then(emit)
    }, 400)
  })
}
