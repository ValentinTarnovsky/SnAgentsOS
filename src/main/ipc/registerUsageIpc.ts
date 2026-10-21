import { ipcMain, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { UsageRow, UsageSnapshot } from '@shared/ipc-contract'
import type { PaneStatusEvt, UsageSettings } from '@shared/types'
import type { UsageActiveAccount } from '@shared/claude-accounts'
import { fetchClaudeUsage, type ClaudeRowFlags } from '../usage/claude'
import { ClaudePoll } from '../usage/claudePoll'
import { CodexUsage } from '../usage/codexUsage'
import { computeCustomRows } from '../usage/custom'
import { fetchServiceStatus, type ServiceStatus } from '../usage/status'

/** Claude multi-account hooks (app 2.3.0); AccountService behind them. */
export interface UsageAccountsHooks {
  /** The switch policy needs 5h and 7d even when the user hides them. */
  windowsNeeded(): boolean
  /** The active account for the snapshot (no email, it reaches the phone). */
  badge(): UsageActiveAccount | null
  /** The full Claude fetch result of the active account, before hidden rows are dropped. */
  onActiveResult(rows: UsageRow[], at: number): void
  /** Cheap check of the live login on every Claude tick. */
  reconcile(): void
}

interface UsageIpcHooks {
  getSender: () => WebContents | null
  /** Usage settings from the persisted config at startup (before the renderer connects). */
  getInitialConfig: () => UsageSettings | null
  /** Agent status stream (StatusManager.addListener): a finished Codex turn triggers a Codex refresh. */
  onStatus?: (cb: (evt: PaneStatusEvt) => void) => () => void
  accounts?: UsageAccountsHooks
  /** Test seam over the Claude fetch (defaults to fetchClaudeUsage). */
  fetchClaude?: typeof fetchClaudeUsage
}

/** What other main services read from the usage poller (AccountService, the CLI). */
export interface UsageHandle {
  /** The current snapshot (what the renderer has). */
  get(): UsageSnapshot
  /** The snapshot `usage:get` answers: fetched once when nothing was fetched yet (`snaos usage`). */
  load(): Promise<UsageSnapshot>
  /** The usage feature is on (only then does anything poll). */
  enabled(): boolean
  /** Drop the held Claude rows and fetch again now (after an account switch), then push. */
  refreshClaudeNow(): Promise<void>
  /** Push the current snapshot again (the Claude account badge changed). */
  republish(): void
  /** The normalized Claude poll interval (ms), without a config read. */
  intervalMs(): number
}

/** Flags of the Claude fetch: the shown rows, plus 5h and 7d when the policy needs them. */
export function claudeFetchFlags(rows: UsageSettings['rows'], needed: boolean): ClaudeRowFlags {
  const base: ClaudeRowFlags = {
    claude5h: rows.claude5h,
    claude7d: rows.claude7d,
    claudeOpus7d: rows.claudeOpus7d,
    claudeSonnet7d: rows.claudeSonnet7d,
  }
  return needed ? { ...base, claude5h: true, claude7d: true } : base
}

/** The fetched Claude rows minus the ones the user hid (fetched only for the policy). */
export function displayRows(rows: UsageRow[], shown: UsageSettings['rows']): UsageRow[] {
  return rows.filter((r) => !((r.id === 'claude.5h' && !shown.claude5h) || (r.id === 'claude.7d' && !shown.claude7d)))
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

// The Claude endpoint is remote (don't hammer it). The Codex minimum applies to
// the local-rollout fallback, a cheap tail read; the remote Codex endpoint is
// separately held to max(60s, codexIntervalMs) inside CodexUsage.
const MIN_CLAUDE_MS = 30000
const MIN_CODEX_MS = 3000
/** Wait after a Codex turn finishes before re-reading (the quota lands a moment after the turn). */
const CODEX_TURN_DEBOUNCE_MS = 2000

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
 *    `claudeIntervalMs`, with back-off after failures (see ClaudePoll).
 *  - Codex, on `codexIntervalMs`: the live `wham/usage` endpoint when available
 *    (at most every max(60s, interval)), else the local rollout files (see
 *    CodexUsage). A finished Codex turn forces a debounced refresh.
 * Each tick refreshes its own cache and pushes a merged `UsageSnapshot` on
 * `usage:update`. Tokens/cookies never leave the main process; only computed
 * percentages and labels are sent.
 */
export function registerUsageIpc(hooks: UsageIpcHooks): UsageHandle {
  const { getSender, getInitialConfig } = hooks
  let cfg = normalize(getInitialConfig())

  const claudePoll = new ClaudePoll()
  const codexUsage = new CodexUsage()
  let codexRows: UsageRow[] = []
  let customRows: UsageRow[] = []
  let services: ServiceStatus | null = null
  let lastUpdated = 0

  let claudeTimer: NodeJS.Timeout | null = null
  let codexTimer: NodeJS.Timeout | null = null
  let claudeInFlight: Promise<void> | null = null
  // Bumped by refreshClaudeNow (account switch): a fetch that started before
  // it belongs to the previous account and is dropped.
  let claudeGen = 0
  let codexInFlight: Promise<void> | null = null
  let configDebounce: NodeJS.Timeout | null = null
  let codexTurnDebounce: NodeJS.Timeout | null = null

  const snapshot = (): UsageSnapshot => {
    const activeAccount = hooks.accounts?.badge() ?? null
    return {
      rows: [...claudePoll.rows, ...codexRows, ...customRows],
      updatedAt: lastUpdated || Date.now(),
      services: cfg.showStatus ? services : null,
      ...(activeAccount ? { activeAccount } : {}),
    }
  }

  const emit = (): void => {
    const wc = getSender()
    if (wc && !wc.isDestroyed()) wc.send(CH.USAGE_UPDATE, snapshot())
  }

  /** (Re)arm the single Claude timer; every Claude refresh re-arms it with the policy's next delay. */
  function armClaude(delayMs: number): void {
    if (claudeTimer) {
      clearTimeout(claudeTimer)
      claudeTimer = null
    }
    if (!cfg.enabled) return
    claudeTimer = setTimeout(() => {
      claudeTimer = null
      void refreshClaude().then(emit)
    }, delayMs)
  }

  /**
   * `bypassBackoff` is only for a changed row selection: the user asked for
   * rows the cache does not hold. Timer, focus and Refresh ticks never call
   * the endpoint while it asked us to back off (the cache stays, flagged stale).
   */
  function refreshClaude(bypassBackoff = false): Promise<void> {
    if (claudeInFlight) return claudeInFlight
    const run = (async (): Promise<void> => {
      let next = cfg.claudeIntervalMs
      const gen = claudeGen
      try {
        hooks.accounts?.reconcile()
        const t = Date.now()
        if (bypassBackoff || claudePoll.canFetch(t)) {
          const res = await (hooks.fetchClaude ?? fetchClaudeUsage)(claudeFetchFlags(cfg.rows, hooks.accounts?.windowsNeeded() === true))
          if (gen === claudeGen) {
            hooks.accounts?.onActiveResult(res.rows, Date.now())
            // A lone transient failure (timeout/5xx/429) used to flip the bars to
            // "Error" for one cycle. ClaudePoll holds the last-good rows (flagged
            // stale) through a short grace window so only a sustained outage
            // surfaces. Expired/nodata aren't all-error, so those still show at once.
            next = claudePoll.apply({ ...res, rows: displayRows(res.rows, cfg.rows) }, cfg.claudeIntervalMs, Date.now())
          }
        } else {
          next = claudePoll.skipDelay(cfg.claudeIntervalMs, t)
        }
        customRows = computeCustomRows(cfg.custom)
        services = cfg.showStatus ? await fetchServiceStatus() : null
        lastUpdated = Date.now()
      } catch (err) {
        console.error('[usage] claude refresh failed:', err instanceof Error ? err.name : 'error')
      } finally {
        armClaude(next)
      }
    })()
    claudeInFlight = run.finally(() => {
      claudeInFlight = null
    })
    return claudeInFlight
  }

  /** Concurrent callers share the in-flight read; a forced one runs once more right after it. */
  function refreshCodex(force = false): Promise<void> {
    if (codexInFlight) return force ? codexInFlight.then(() => refreshCodex(true)) : codexInFlight
    const run = (async (): Promise<void> => {
      try {
        codexRows = await codexUsage.refresh(cfg.rows, cfg.codexIntervalMs, force)
        lastUpdated = Date.now()
      } catch (err) {
        console.error('[usage] codex refresh failed:', err)
      }
    })()
    codexInFlight = run.finally(() => {
      codexInFlight = null
    })
    return codexInFlight
  }

  async function refreshAll(force = false, bypassBackoff = false): Promise<void> {
    await Promise.all([refreshCodex(force), refreshClaude(bypassBackoff)])
  }

  function schedule(): void {
    if (codexTimer) {
      clearInterval(codexTimer)
      codexTimer = null
    }
    armClaude(cfg.claudeIntervalMs)
    if (!cfg.enabled) return
    codexTimer = setInterval(() => {
      void refreshCodex().then(emit)
    }, cfg.codexIntervalMs)
  }

  // Window focus / Refresh button already force a full refresh through USAGE_REFRESH.
  // A finished Codex turn is the other moment the quota visibly changes.
  hooks.onStatus?.((evt) => {
    if (!cfg.enabled || evt.provider !== 'codex' || evt.state !== 'done') return
    if (codexTurnDebounce) clearTimeout(codexTurnDebounce)
    codexTurnDebounce = setTimeout(() => {
      codexTurnDebounce = null
      void refreshCodex(true).then(emit)
    }, CODEX_TURN_DEBOUNCE_MS)
  })

  // Initial kick + scheduling.
  if (cfg.enabled) {
    void refreshAll().then(emit)
  }
  schedule()

  const load = async (): Promise<UsageSnapshot> => {
    if (lastUpdated === 0 && cfg.enabled) await refreshAll()
    return snapshot()
  }

  ipcMain.handle(CH.USAGE_GET, load)

  ipcMain.handle(CH.USAGE_REFRESH, async (): Promise<UsageSnapshot> => {
    await refreshAll(true)
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
      void refreshAll(false, true).then(emit)
    }, 400)
  })

  return {
    get: snapshot,
    load,
    enabled: () => cfg.enabled,
    republish: emit,
    intervalMs: () => cfg.claudeIntervalMs,
    async refreshClaudeNow(): Promise<void> {
      claudeGen += 1
      claudePoll.reset()
      emit()
      if (claudeInFlight) await claudeInFlight
      if (cfg.enabled) await refreshClaude(true)
      emit()
    },
  }
}
