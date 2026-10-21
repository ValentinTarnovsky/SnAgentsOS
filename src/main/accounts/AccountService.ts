import { createHash, randomBytes } from 'crypto'
import { watch as fsWatch, type FSWatcher } from 'fs'
import {
  MAX_CLAUDE_ACCOUNTS,
  normalizeAccountsSettings,
  rankOfRole,
  roleOfRank,
  type AccountsCaptureReq,
  type AccountsOpError,
  type AccountsOpRes,
  type ClaudeAccountView,
  type ClaudeAccountWindowView,
  type ClaudeAccountsEvent,
  type ClaudeAccountsState,
  type ClaudeAutoPause,
  type ClaudeSwitchReason,
  type UsageActiveAccount,
  type UsageOtherAccount,
  cleanAccountLabel,
} from '@shared/claude-accounts'
import type { UsageRow } from '@shared/ipc-contract'
import type { ClaudeAccountsSettings, ConfigFile, PaneStatusEvt } from '@shared/types'
import { mainT } from '../i18n'
import { claudeConfigDir } from '../status/statusDetails'
import { fetchClaudeUsage, type OauthCred } from '../usage/claude'
import * as claudeFiles from './claudeFiles'
import { fetchClaudeProfile, type ClaudeProfile } from './profile'
import { ANCHOR_REASONS, emptyMeta, type AccountVault, type VaultAccountMeta, type VaultMeta, type WindowSample } from './AccountVault'
import type { VaultCrypto } from './safeCrypto'
import { decide, emptyPolicyMemory, type PolicyAccount, type PolicyMemory, type PolicyWindow } from './switchPolicy'

/**
 * Claude multi-account (app 2.3.0, item 9). Main owns the saved accounts
 * (AccountVault) and is the only writer of the live `.credentials.json`.
 *
 * SPIKE 2026-10-20 (Claude Code 2.1.305, two real accounts):
 *  - a running `claude` reads the file on every request, so a switch reaches
 *    every console without a restart (CLAUDE_LIVE_SWITCH);
 *  - no write-back: a process with X in memory uses the Y now on disk;
 *  - strict rotation: a refresh rotates the refresh token and the old one
 *    stops working, and a failed refresh empties the file (a logout).
 * So: the active account is captured again on every change of the live file
 * and always right before leaving it; a parked snapshot stays valid because
 * nobody uses it; one copy per grant; if the file is emptied after one of our
 * switches (the target's refresh failed) the previous account goes back
 * (rollback), the target needs a new capture and automatic switching pauses.
 * `.claude.json` is read-only for us (its stale `oauthAccount` breaks nothing).
 *
 * Logs carry codes only (`parse`, `EPERM`, `http_401`), never `err.message`,
 * file contents, tokens or emails. Nothing returned here carries a token.
 *
 * App 2.4.0: up to MAX_CLAUDE_ACCOUNTS accounts, in the vault's order (the
 * priority; `rank` is the index). A capture appends (or replaces one in
 * place), `move` / `reorder` change the order, each account keeps its own
 * `exhaustedUntil`, and a switch the user made (manual, phone, cli, an outside
 * /login, a capture) sets the anchor the automatic return stops at. Parked
 * accounts are polled one per tick in turn, each with its own access token
 * while it is valid, and never refreshed: after that the policy estimates.
 */
export const CLAUDE_LIVE_SWITCH = true

const MIN = 60_000
const TICK_MS = 30_000
const WATCH_DEBOUNCE_MS = 300
const VERIFY_MS = 1500
const PROFILE_MIN_MS = 60_000
/**
 * A login of the account we just left, inside this window, is a write-back
 * (an in-flight refresh racing our switch). Short on purpose: the SPIKE saw no
 * write-back, so a later login of that account is the user's own `/login` and
 * is followed as an external switch, never reverted.
 */
const WRITEBACK_WINDOW_MS = 3 * MIN
const CONFLICT_WINDOW_MS = 30 * MIN
/**
 * An emptied file rolls back only while the target's refresh was due (its
 * access token within 5 min of expiry) and within this time of the later of
 * our switch and that expiry. Any other emptied file is a sign-out: nothing
 * is written, the user is told.
 */
const ROLLBACK_WINDOW_MS = 12 * 60 * MIN
const PARKED_MIN_MS = 5 * MIN
/** The parked account is polled only while its access token has this much life left. */
const PARKED_TOKEN_MARGIN_MS = 5 * MIN
const LAST_USAGE_PERSIST_MS = 10 * MIN
const BUSY_WAIT_MS = 10_000

export interface AccountFilesApi {
  readCredentials: typeof claudeFiles.readCredentials
  readOauthAccount: typeof claudeFiles.readOauthAccount
  writeCredentials: (raw: string) => Promise<void>
}

export interface AccountServiceApi {
  list(): ClaudeAccountView[]
  status(): ClaudeAccountsState
  switchTo(idOrRole: string, reason: ClaudeSwitchReason): Promise<AccountsOpRes>
}

export interface AccountAlert {
  title: string
  body: string
  event: ClaudeAccountsEvent
}

export interface AccountServiceDeps {
  vault: AccountVault
  crypto: VaultCrypto
  /** Test seam over claudeFiles (defaults to the live files of claudeConfigDir()). */
  files?: Partial<AccountFilesApi>
  profile?: (accessToken: string) => Promise<ClaudeProfile>
  fetchUsage?: typeof fetchClaudeUsage
  statuses: () => PaneStatusEvt[]
  /** State to the renderer (accounts:changed). */
  emit: (s: ClaudeAccountsState) => void
  /** Event to the renderer (accounts:event). */
  event: (e: ClaudeAccountsEvent) => void
  /** Native + remote notice (title and body already translated, no email). */
  alert: (a: AccountAlert) => void
  /** Language of the notices. */
  config?: () => ConfigFile | null
  usageIntervalMs?: () => number
  usageEnabled?: () => boolean
  now?: () => number
  platform?: NodeJS.Platform
  /** null: no fs watcher (tests). */
  watch?: typeof fsWatch | null
  claudeDir?: () => string
  /** false: no timers (tests drive reconcile / tick by hand). */
  autoStart?: boolean
  verifyDelayMs?: number
}

/** The usage poller, as AccountService drives it. */
export interface UsageControl {
  /** Drop the held Claude rows and fetch the (new) active account now. */
  refreshActive(): Promise<void>
  /** Push the usage snapshot again (the account badge changed). */
  republish(): void
}

interface UsageSampleSet {
  fiveHour: WindowSample
  sevenDay: WindowSample
  ok: boolean
  source: 'live' | 'parked'
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const identityKey = (accountUuid: string, organizationUuid: string | null): string => `${accountUuid}:${organizationUuid ?? ''}`
const tokenOf = (cred: OauthCred | null): { access: string | null; refresh: string | null; expiresAt: number | null } => {
  const o = cred?.claudeAiOauth
  return {
    access: typeof o?.accessToken === 'string' && o.accessToken ? o.accessToken : null,
    refresh: typeof o?.refreshToken === 'string' && o.refreshToken ? o.refreshToken : null,
    expiresAt: typeof o?.expiresAt === 'number' ? o.expiresAt : null,
  }
}
const parseIso = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}
const noSample = (): WindowSample => ({ percent: null, resetsAt: null, at: null })
const errCode = (err: unknown): string => (err instanceof Error && /^[A-Za-z0-9_]{2,24}$/.test(err.message) ? err.message : claudeFiles.errCode(err))

/** Title and body of a notice, by labels or "Account N" (never an email). */
export function accountsNoticeText(cfg: ConfigFile | null, e: ClaudeAccountsEvent, nameOf: (id: string | undefined) => string): { title: string; body: string } {
  const windowName = e.window ? mainT(cfg, e.window === '5h' ? 'accounts.window.5h' : 'accounts.window.7d') : ''
  switch (e.kind) {
    case 'switched':
      return {
        title: mainT(cfg, 'accounts.switched.title'),
        body:
          e.reason === 'auto_return'
            ? mainT(cfg, 'accounts.switched.return', { to: nameOf(e.to) })
            : mainT(cfg, 'accounts.switched.auto', { to: nameOf(e.to), from: nameOf(e.from), percent: e.percent ?? 0, window: windowName }),
      }
    case 'allExhausted':
      return { title: mainT(cfg, 'accounts.allExhausted.title'), body: mainT(cfg, 'accounts.allExhausted', { active: nameOf(e.from) }) }
    case 'unknownAccount':
      return { title: mainT(cfg, 'accounts.unknown.title'), body: mainT(cfg, 'accounts.unknown') }
    case 'conflict':
      return { title: mainT(cfg, 'accounts.conflict.title'), body: mainT(cfg, 'accounts.conflict', { account: nameOf(e.from) }) }
    case 'rollback':
      return { title: mainT(cfg, 'accounts.rollback.title'), body: mainT(cfg, 'accounts.rollback', { failed: nameOf(e.from), to: nameOf(e.to) }) }
    case 'locked':
      return { title: mainT(cfg, 'accounts.locked.title'), body: mainT(cfg, 'accounts.locked') }
    case 'loggedOut':
      return { title: mainT(cfg, 'accounts.loggedOut.title'), body: mainT(cfg, 'accounts.loggedOut', { account: nameOf(e.from) }) }
  }
}

export class AccountService implements AccountServiceApi {
  private meta: VaultMeta = emptyMeta()
  private cfg: ClaudeAccountsSettings = normalizeAccountsSettings(null)
  private readonly files: AccountFilesApi
  private readonly now: () => number
  private unsupportedReason: ClaudeAccountsState['unsupportedReason'] | null = null
  /** sha256 of each snapshot's refresh token and raw blob (never the tokens). */
  private readonly fp = new Map<string, { rt: string; raw: string }>()
  private lastSeenHash: string | null = null
  private liveIdentity: ClaudeAccountsState['liveIdentity'] = 'none'
  private liveEmail: string | null = null
  /** The live login changed and could not be identified yet (profile unreachable). */
  private liveUnverified = false
  private lastProfileAt = -Infinity
  private unknownNotified: string | null = null
  private writeBacks: number[] = []
  private policyMem: PolicyMemory = emptyPolicyMemory()
  private pending: ClaudeAccountsState['pending'] = null
  private blocked: ClaudeAccountsState['blocked'] = null
  private readonly usage = new Map<string, UsageSampleSet>()
  private readonly tokenStates = new Map<string, ClaudeAccountView['tokenState']>()
  private readonly parked = new Map<string, { nextAt: number; stopped: boolean }>()
  /** Round robin over the parked accounts: the id polled last. */
  private parkedLast: string | null = null
  private parkedBusy = false
  private evaluating = false
  private chain: Promise<unknown> = Promise.resolve()
  private persistChain: Promise<void> = Promise.resolve()
  private lastUsagePersist = 0
  private lastEmitted = ''
  /** The phone badge last pushed through the usage snapshot (JSON). */
  private lastBadge = ''
  private usageControl: UsageControl | null = null
  private watcher: FSWatcher | null = null
  private watchTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  /** The 1.5 s look after one of our switches. */
  private verifyTimer: NodeJS.Timeout | null = null
  private disposed = false
  /** False until init() loaded the vault and checked every snapshot: nothing classifies the live file before. */
  private ready = false

  constructor(private readonly deps: AccountServiceDeps) {
    this.now = deps.now ?? Date.now
    this.files = {
      readCredentials: deps.files?.readCredentials ?? ((p) => claudeFiles.readCredentials(p)),
      readOauthAccount: deps.files?.readOauthAccount ?? ((p) => claudeFiles.readOauthAccount(p)),
      writeCredentials: deps.files?.writeCredentials ?? ((raw) => claudeFiles.writeCredentials(raw)),
    }
  }

  // --- lifecycle ---------------------------------------------------------------

  /** Load the vault, check every snapshot decrypts, look at the live login, start the watcher and the 30 s tick. */
  async init(cfg: ClaudeAccountsSettings | null): Promise<void> {
    this.cfg = normalizeAccountsSettings(cfg)
    const platform = this.deps.platform ?? process.platform
    if (platform === 'darwin') this.unsupportedReason = 'keychain'
    else if (!this.deps.crypto.available()) this.unsupportedReason = 'encryption_unavailable'
    this.meta = this.deps.vault.load()
    // Built from the 2.3.0 accounts.json: written once as accounts.v2.json
    // (accounts.json itself is never written again).
    if (this.deps.vault.migratedFromV1) await this.persist()
    for (const a of this.meta.accounts) {
      if (a.lastUsage) this.usage.set(a.id, { fiveHour: a.lastUsage.fiveHour, sevenDay: a.lastUsage.sevenDay, ok: true, source: 'parked' })
    }
    if (!this.unsupportedReason) {
      let locked = false
      for (const a of this.meta.accounts) {
        const { snap, failed } = await this.deps.vault.readSnapshot(a.id)
        if (snap) this.setFingerprint(a.id, snap.credentialsRaw)
        else {
          // Missing or undecryptable (a portable folder moved to another user or PC).
          if (!a.needsRecapture) locked = true
          a.needsRecapture = true
          if (failed) this.tokenStates.set(a.id, 'invalid')
        }
      }
      if (locked && this.meta.autoPaused === null) this.meta.autoPaused = 'locked'
      if (locked) await this.persist()
      // A quit during the async load: no reconcile, no watcher, no timers.
      if (this.disposed) return
      this.ready = true
      await this.reconcile()
    }
    if (this.disposed) return
    if (this.deps.autoStart !== false && !this.unsupportedReason) this.start()
  }

  private start(): void {
    const watch = this.deps.watch === undefined ? fsWatch : this.deps.watch
    if (watch) {
      try {
        this.watcher = watch((this.deps.claudeDir ?? claudeConfigDir)(), { persistent: false }, (_evt, filename) => {
          if (filename && String(filename) !== '.credentials.json') return
          if (this.watchTimer) clearTimeout(this.watchTimer)
          this.watchTimer = setTimeout(() => {
            this.watchTimer = null
            void this.reconcile()
          }, WATCH_DEBOUNCE_MS)
        })
        this.watcher.on('error', () => {
          this.watcher?.close()
          this.watcher = null
        })
      } catch {
        // No Claude folder yet: the 30 s tick covers it.
        this.watcher = null
      }
    }
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS)
    this.tickTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.watchTimer) clearTimeout(this.watchTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.verifyTimer) clearTimeout(this.verifyTimer)
    this.watchTimer = null
    this.tickTimer = null
    this.verifyTimer = null
    try {
      this.watcher?.close()
    } catch {
      /* already closed */
    }
    this.watcher = null
  }

  /** Safety poll: reconcile, poll the parked account, run the policy, persist the usage now and then. */
  async tick(): Promise<void> {
    if (this.disposed || this.unsupportedReason) return
    await this.reconcile()
    await this.pollParked()
    this.evaluate()
    if (this.now() - this.lastUsagePersist >= LAST_USAGE_PERSIST_MS) {
      this.lastUsagePersist = this.now()
      this.storeLastUsage()
      await this.persist()
    }
  }

  setConfig(cfg: ClaudeAccountsSettings): void {
    this.cfg = normalizeAccountsSettings(cfg)
    this.evaluate()
    this.emitState()
  }

  /** The normalized automatic-switch settings in force (a copy; `snaos account status`). */
  settings(): ClaudeAccountsSettings {
    return { ...this.cfg }
  }

  setUsageControl(c: UsageControl): void {
    this.usageControl = c
  }

  // --- views -------------------------------------------------------------------

  private supported(): boolean {
    return this.unsupportedReason === null
  }

  private windowView(acc: VaultAccountMeta, which: 'fiveHour' | 'sevenDay'): ClaudeAccountWindowView {
    const set = this.usage.get(acc.id)
    const w = set?.[which]
    if (!w || (w.percent === null && w.resetsAt === null)) return { percent: null, resetsAt: null, at: null, source: 'none' }
    const reset = parseIso(w.resetsAt)
    if (reset !== null && this.now() >= reset) return { percent: 0, resetsAt: null, at: w.at, source: 'estimated' }
    const live = set?.source === 'live' && acc.id === this.meta.activeId
    return { percent: w.percent, resetsAt: w.resetsAt, at: w.at, source: live ? 'live' : 'parked' }
  }

  private rankOf(a: VaultAccountMeta): number {
    return this.meta.accounts.indexOf(a)
  }

  private view(a: VaultAccountMeta, rank: number): ClaudeAccountView {
    return {
      id: a.id,
      rank,
      role: roleOfRank(rank),
      label: a.label,
      email: a.email,
      organizationName: a.organizationName,
      subscriptionType: a.subscriptionType,
      capturedAt: a.capturedAt,
      active: a.id === this.meta.activeId,
      tokenState: a.needsRecapture ? 'invalid' : (this.tokenStates.get(a.id) ?? 'ok'),
      needsRecapture: a.needsRecapture,
      identityConfirmed: a.identityConfirmed,
      usage: { fiveHour: this.windowView(a, 'fiveHour'), sevenDay: this.windowView(a, 'sevenDay') },
    }
  }

  /** By priority (the vault's order). */
  list(): ClaudeAccountView[] {
    return this.meta.accounts.map((a, i) => this.view(a, i))
  }

  status(): ClaudeAccountsState {
    return {
      supported: this.supported(),
      ...(this.unsupportedReason ? { unsupportedReason: this.unsupportedReason } : {}),
      liveSwitch: CLAUDE_LIVE_SWITCH,
      accounts: this.list(),
      activeId: this.meta.activeId,
      liveIdentity: this.liveIdentity,
      ...(this.liveIdentity === 'unknown' ? { liveEmail: this.liveEmail } : {}),
      ...(this.liveUnverified ? { liveUnverified: true } : {}),
      autoPaused: this.meta.autoPaused,
      anchorId: this.meta.anchorId,
      lastSwitch: this.meta.lastSwitch,
      pending: this.pending,
      blocked: this.blocked,
      restartNeeded: [],
    }
  }

  /** The policy needs the 5h and 7d windows even when the user hides them. */
  windowsNeeded(): boolean {
    return this.cfg.autoSwitch && this.meta.accounts.length >= 2
  }

  /** Label without an `@`, so an email typed as a label never reaches the phone. */
  private phoneLabel(a: VaultAccountMeta): string {
    return a.label.includes('@') ? '' : a.label
  }

  /** The active account for the usage snapshot (no email; it travels to the phone). */
  badge(): UsageActiveAccount | null {
    // An unidentified live login may be another account: the usage rows come
    // from its token, so they are not labelled with the last active one.
    if (this.liveUnverified) return null
    const active = this.meta.accounts.find((a) => a.id === this.meta.activeId)
    if (!active) return null
    const rank = this.rankOf(active)
    const others: UsageOtherAccount[] = this.meta.accounts
      .map((a, i) => ({ id: a.id, rank: i, role: roleOfRank(i), label: this.phoneLabel(a), ready: !a.needsRecapture }))
      .filter((a) => a.id !== active.id)
      .slice(0, MAX_CLAUDE_ACCOUNTS)
    // The 2.3.0 phone switches by role: `other` is the first other account
    // by rank (rank 0, or 1 when the active one is 0), so its role names it.
    const other = others[0]
    return {
      id: active.id,
      rank,
      role: roleOfRank(rank),
      label: this.phoneLabel(active),
      ...(other ? { other: { id: other.id, rank: other.rank, role: other.role, label: other.label } } : {}),
      ...(others.length ? { others } : {}),
    }
  }

  /** The label, else "Account N" (1-based rank); never an email. */
  private nameOf(id: string | undefined): string {
    const cfg = this.deps.config?.() ?? null
    const i = this.meta.accounts.findIndex((x) => x.id === id)
    if (i < 0) return mainT(cfg, 'accounts.unknownName')
    return this.phoneLabel(this.meta.accounts[i]) || mainT(cfg, 'accounts.accountN', { n: i + 1 })
  }

  private emitState(force = false): void {
    // The 2.3.0 phone names its "Use <other>" target by role (a rank): a
    // changed badge (a reorder, a capture, a removal) is pushed at once, not
    // on the next usage tick.
    const badge = JSON.stringify(this.badge())
    if (badge !== this.lastBadge) {
      this.lastBadge = badge
      try {
        this.usageControl?.republish()
      } catch {
        /* no window */
      }
    }
    const s = this.status()
    const json = JSON.stringify(s)
    if (!force && json === this.lastEmitted) return
    this.lastEmitted = json
    try {
      this.deps.emit(s)
    } catch {
      /* no window */
    }
  }

  private fire(e: ClaudeAccountsEvent, alert: boolean): void {
    try {
      this.deps.event(e)
    } catch {
      /* no window */
    }
    if (!alert) return
    try {
      const { title, body } = accountsNoticeText(this.deps.config?.() ?? null, e, (id) => this.nameOf(id))
      this.deps.alert({ title, body, event: e })
    } catch {
      /* notices are best effort */
    }
  }

  // --- helpers -----------------------------------------------------------------

  /** Saves of accounts.json run one after another (two atomic writes never race). */
  private persist(): Promise<void> {
    const next = this.persistChain.then(async () => {
      try {
        await this.deps.vault.saveMeta(this.meta)
      } catch (err) {
        console.warn('[accounts] saving the account list failed:', errCode(err))
      }
    })
    this.persistChain = next
    return next
  }

  private setFingerprint(id: string, raw: string): void {
    const rt = tokenOf(claudeFiles.parseCredentials(raw)).refresh
    this.fp.set(id, { rt: rt ? sha(rt) : '', raw: sha(raw) })
  }

  private byRt(rtHash: string): VaultAccountMeta | undefined {
    if (!rtHash) return undefined
    return this.meta.accounts.find((a) => this.fp.get(a.id)?.rt === rtHash)
  }

  /** An id, or a 2.3.0 role: 'primary' is rank 0, 'secondary' rank 1. */
  private resolve(idOrRole: string): VaultAccountMeta | undefined {
    if (idOrRole === 'primary' || idOrRole === 'secondary') return this.meta.accounts[rankOfRole(idOrRole)]
    return this.meta.accounts.find((a) => a.id === idOrRole)
  }

  /** Serialized mutation. With `busy`, a caller that waited more than 10 s gets `busy` instead. */
  private run<T>(fn: () => Promise<T>, busy?: () => T): Promise<T> {
    const prev = this.chain
    const p = (async (): Promise<T> => {
      if (busy) {
        let timer: NodeJS.Timeout | null = null
        const late = new Promise<'busy'>((r) => {
          timer = setTimeout(() => r('busy'), BUSY_WAIT_MS)
        })
        const r = await Promise.race([prev.then(() => 'ready' as const), late])
        if (timer) clearTimeout(timer)
        if (r === 'busy') return busy()
      } else {
        await prev
      }
      return fn()
    })()
    this.chain = Promise.allSettled([prev, p])
    return p
  }

  private res(ok: boolean, error?: AccountsOpError): AccountsOpRes {
    return { ok, ...(error ? { error } : {}), state: this.status() }
  }

  /** Save the live login as this account's snapshot (the re-capture). Only `claudeAiOauth` is kept. */
  private async recapture(acc: VaultAccountMeta, cred: OauthCred): Promise<boolean> {
    const raw = claudeFiles.snapshotRaw(cred)
    const fp = this.fp.get(acc.id)
    if (fp && fp.raw === sha(raw) && !acc.needsRecapture) return true
    try {
      await this.deps.vault.putSnapshot(acc.id, { v: 1, credentialsRaw: raw, capturedAt: this.now() })
    } catch (err) {
      console.warn('[accounts] saving a login failed:', errCode(err))
      return false
    }
    this.setFingerprint(acc.id, raw)
    acc.updatedAt = this.now()
    const sub = cred.claudeAiOauth?.subscriptionType
    if (typeof sub === 'string' && sub) acc.subscriptionType = sub.slice(0, 64)
    acc.needsRecapture = false
    this.tokenStates.set(acc.id, 'ok')
    this.parked.delete(acc.id)
    this.clearLockIfFixed()
    return true
  }

  /** `locked` / `refreshFailed` lift by themselves once no account needs a capture. */
  private clearLockIfFixed(): void {
    if ((this.meta.autoPaused === 'locked' || this.meta.autoPaused === 'refreshFailed') && !this.meta.accounts.some((a) => a.needsRecapture)) {
      this.meta.autoPaused = null
    }
  }

  private setLiveKnown(): void {
    this.liveIdentity = 'known'
    this.liveEmail = null
    this.liveUnverified = false
    this.unknownNotified = null
    if (this.meta.autoPaused === 'unknownAccount' || this.meta.autoPaused === 'noLogin') this.meta.autoPaused = null
  }

  private async identify(token: string, force: boolean): Promise<ClaudeProfile | null> {
    if (!force && this.now() - this.lastProfileAt < PROFILE_MIN_MS) return null
    this.lastProfileAt = this.now()
    return (this.deps.profile ?? ((t: string) => fetchClaudeProfile(t)))(token)
  }

  // --- reconcile ---------------------------------------------------------------

  /** Classify the live file (see the class comment). Cheap when nothing changed. */
  reconcile(): Promise<void> {
    if (this.disposed || this.unsupportedReason || !this.ready) return Promise.resolve()
    return this.run(async () => {
      // A quit while this waited in the chain: never write during shutdown.
      if (this.disposed) return
      await this.reconcileInner(false)
      // Deduped by JSON: also carries a changed liveUnverified.
      this.emitState()
    })
  }

  /** The value lastSeenHash holds for this read (null: unreadable). */
  private liveKey(live: claudeFiles.LiveCredentials): string | null {
    if (live.kind === 'missing') return 'missing'
    if (live.kind === 'bad') return null
    return sha(live.raw)
  }

  /** True when anything visible changed. */
  private async reconcileInner(force: boolean): Promise<boolean> {
    const live = await this.files.readCredentials()
    if (live.kind === 'bad') return false
    const now = this.now()
    const v0 = this.meta.verify
    if (v0 && now > Math.max(v0.at, v0.targetExpiresAt ?? v0.at) + ROLLBACK_WINDOW_MS) this.meta.verify = null

    if (live.kind === 'missing') {
      if (this.lastSeenHash === 'missing') return false
      this.lastSeenHash = 'missing'
      return this.noLogin()
    }
    const hash = sha(live.raw)
    if (live.kind === 'empty') {
      if (hash === this.lastSeenHash) return false
      this.lastSeenHash = hash
      const v = this.meta.verify
      const from = v?.from ? this.meta.accounts.find((a) => a.id === v.from) : undefined
      // A failed refresh of the target only once its refresh was due; an
      // emptied file while its access token is still good is a sign-out.
      const due = !!v && (v.targetExpiresAt === null || now >= v.targetExpiresAt - PARKED_TOKEN_MARGIN_MS)
      if (v && due && v.to === this.meta.activeId && from && !from.needsRecapture) return this.rollback(v.to, from, live.raw)
      // The active login ended (failed refresh or sign-out): its saved copy holds the same dead grant.
      const active = this.meta.accounts.find((a) => a.id === this.meta.activeId)
      if (active) {
        active.needsRecapture = true
        this.tokenStates.set(active.id, 'invalid')
      }
      this.meta.verify = null
      const r = this.noLogin()
      if (active) this.fire({ kind: 'loggedOut', auto: false, from: active.id, at: now }, true)
      return r
    }

    if (hash === this.lastSeenHash && !this.liveUnverified) return false
    const tok = tokenOf(live.cred)
    const rtHash = tok.refresh ? sha(tok.refresh) : ''
    const match = this.byRt(rtHash)
    if (match) {
      this.lastSeenHash = hash
      await this.recapture(match, live.cred)
      if (match.id !== this.meta.activeId) this.external(match)
      this.setLiveKnown()
      await this.persist()
      return true
    }

    // A refresh token we do not hold: a rotation of the active account, a
    // write-back of the one we left, or a /login. Only the profile tells.
    if (!tok.access || (tok.expiresAt !== null && tok.expiresAt <= now)) {
      this.liveUnverified = true
      return false
    }
    const p = await this.identify(tok.access, force)
    if (!p) {
      this.liveUnverified = true
      return false
    }
    if (!p.ok) {
      if (p.status === 'network' || (typeof p.status === 'number' && (p.status === 429 || p.status >= 500))) {
        this.liveUnverified = true
        return false
      }
      this.lastSeenHash = hash
      return this.unknownLogin(null, hash)
    }
    this.lastSeenHash = hash
    this.liveUnverified = false
    const key = identityKey(p.accountUuid, p.organizationUuid)
    const acc = this.meta.accounts.find((a) => identityKey(a.accountUuid, a.organizationUuid) === key)
    if (!acc) return this.unknownLogin(p.email, hash)
    if (acc.id === this.meta.activeId) {
      // Rotation of the active login: capture it (it is the only valid copy now).
      await this.recapture(acc, live.cred)
      if (this.meta.verify?.to === acc.id) this.meta.verify = null
      acc.identityConfirmed = true
      this.setLiveKnown()
      await this.persist()
      return true
    }
    const ls = this.meta.lastSwitch
    const ourSwitch = ls && ls.reason !== 'external' && ls.reason !== 'rollback'
    if (ourSwitch && ls.from === acc.id && now - ls.at < WRITEBACK_WINDOW_MS) {
      await this.writeBack(acc, live.raw, live.cred)
      return true
    }
    await this.recapture(acc, live.cred)
    this.external(acc)
    this.setLiveKnown()
    await this.persist()
    return true
  }

  private noLogin(): boolean {
    this.liveIdentity = 'none'
    this.liveEmail = null
    this.liveUnverified = false
    this.meta.activeId = null
    if (this.meta.accounts.length > 0 && this.meta.autoPaused === null) this.meta.autoPaused = 'noLogin'
    void this.persist()
    return true
  }

  private unknownLogin(email: string | null, hash: string): boolean {
    this.liveIdentity = 'unknown'
    this.liveEmail = email
    // Classified now (the profile answered): no longer unverified, and the
    // next reconcile does not ask the profile again for this same file.
    this.liveUnverified = false
    this.meta.activeId = null
    if (this.meta.autoPaused === null || this.meta.autoPaused === 'noLogin') this.meta.autoPaused = 'unknownAccount'
    void this.persist()
    if (this.unknownNotified !== hash && this.meta.accounts.length > 0) {
      this.unknownNotified = hash
      this.fire({ kind: 'unknownAccount', auto: false, at: this.now() }, this.cfg.autoSwitch)
    }
    return true
  }

  /** The live file holds a saved account main did not write: follow it, no pause. */
  private external(acc: VaultAccountMeta): void {
    const from = this.meta.activeId
    this.meta.activeId = acc.id
    // The user's own /login: the automatic return stops there.
    this.meta.anchorId = acc.id
    this.meta.lastSwitch = { at: this.now(), from, to: acc.id, reason: 'external' }
    this.meta.verify = null
    this.fire({ kind: 'switched', auto: false, from: from ?? undefined, to: acc.id, reason: 'external', at: this.now() }, false)
    void this.usageControl?.refreshActive().catch(() => undefined)
  }

  /** A console refreshed the account we just left and wrote it back. */
  private async writeBack(left: VaultAccountMeta, raw: string, cred: OauthCred): Promise<void> {
    const now = this.now()
    await this.recapture(left, cred)
    this.writeBacks = this.writeBacks.filter((t) => now - t < CONFLICT_WINDOW_MS)
    this.writeBacks.push(now)
    const active = this.meta.accounts.find((a) => a.id === this.meta.activeId)
    const snap = active && this.writeBacks.length < 2 ? await this.deps.vault.getSnapshot(active.id) : null
    if (active && snap) {
      // Re-assert the account we switched to, once (only claudeAiOauth; MCP grants stay as on disk).
      try {
        const merged = claudeFiles.mergeCredentials(raw, snap.credentialsRaw)
        await this.files.writeCredentials(merged)
        this.lastSeenHash = sha(merged)
        this.setLiveKnown()
        await this.persist()
        // A fetch already in flight with the written-back tokens is dropped by generation.
        void this.usageControl?.refreshActive().catch(() => undefined)
        return
      } catch (err) {
        console.warn('[accounts] re-writing the login failed:', errCode(err))
      }
    }
    // Second write-back (or nothing to re-assert): follow the file and pause.
    const from = this.meta.activeId
    this.meta.activeId = left.id
    this.meta.autoPaused = 'conflict'
    this.setLiveKnownKeepPause()
    await this.persist()
    this.fire({ kind: 'conflict', auto: false, from: left.id, to: from ?? undefined, at: now }, true)
  }

  private setLiveKnownKeepPause(): void {
    this.liveIdentity = 'known'
    this.liveEmail = null
    this.liveUnverified = false
  }

  /** The target's refresh failed and emptied the file: put the account we left back. */
  private async rollback(failedId: string, from: VaultAccountMeta, liveRaw: string): Promise<boolean> {
    const failed = this.meta.accounts.find((a) => a.id === failedId)
    const snap = await this.deps.vault.getSnapshot(from.id)
    this.meta.verify = null
    if (failed) {
      failed.needsRecapture = true
      this.tokenStates.set(failed.id, 'invalid')
    }
    // Nothing to put back: Claude stays signed out, and the user is told.
    const signedOut = (): boolean => {
      const r = this.noLogin()
      this.fire({ kind: 'loggedOut', auto: false, from: failedId, at: this.now() }, true)
      return r
    }
    if (!snap) {
      from.needsRecapture = true
      return signedOut()
    }
    const merged = claudeFiles.mergeCredentials(liveRaw, snap.credentialsRaw)
    try {
      await this.files.writeCredentials(merged)
    } catch (err) {
      console.warn('[accounts] rollback write failed:', errCode(err))
      return signedOut()
    }
    const now = this.now()
    this.lastSeenHash = sha(merged)
    this.meta.activeId = from.id
    this.meta.lastSwitch = { at: now, from: failedId, to: from.id, reason: 'rollback' }
    this.setLiveKnown()
    this.meta.autoPaused = 'refreshFailed'
    await this.persist()
    this.fire({ kind: 'rollback', auto: true, from: failedId, to: from.id, reason: 'rollback', at: now }, true)
    void this.usageControl?.refreshActive().catch(() => undefined)
    return true
  }

  // --- capture -----------------------------------------------------------------

  /**
   * Save the live login: the same identity again re-captures it in place;
   * with `replaceId` it takes that account's place (same rank, the old login
   * deleted); else it is appended as the last account (`limit_reached` at
   * MAX_CLAUDE_ACCOUNTS). The 2.3.0 `{ role, replace: true }` replaces the
   * account at that role's rank.
   */
  capture(opts: AccountsCaptureReq = {}): Promise<AccountsOpRes> {
    return this.run(async () => {
      if (this.disposed) return this.res(false, 'busy')
      const r = await this.captureInner(opts)
      this.emitState(true)
      return r
    }, () => this.res(false, 'busy'))
  }

  private async captureInner(opts: AccountsCaptureReq): Promise<AccountsOpRes> {
    if (this.unsupportedReason === 'keychain') return this.res(false, 'unsupported')
    if (this.unsupportedReason || !this.deps.crypto.available()) return this.res(false, 'encryption_unavailable')
    const live = await this.files.readCredentials()
    if (live.kind === 'bad') return this.res(false, 'io')
    if (live.kind !== 'ok') return this.res(false, 'no_login')
    const tok = tokenOf(live.cred)
    const hint = await this.files.readOauthAccount()
    let ident: { accountUuid: string; email: string | null; organizationUuid: string | null; organizationName: string | null; rateLimitTier: string | null; confirmed: boolean } | null = null
    if (tok.access && (tok.expiresAt === null || tok.expiresAt > this.now())) {
      const p = await this.identify(tok.access, true)
      if (p?.ok) ident = { ...p, confirmed: true }
    }
    // The `.claude.json` hint goes stale after any write of ours (SPIKE): it is
    // trusted only when no switch, rollback or write-back of ours came after
    // the last login Claude itself made.
    const ls = this.meta.lastSwitch
    if (!ident && hint && (ls === null || ls.reason === 'external')) ident = { ...hint, rateLimitTier: null, confirmed: false }
    if (!ident) return this.res(false, 'identity_failed')
    const key = identityKey(ident.accountUuid, ident.organizationUuid)
    const existing = this.meta.accounts.find((a) => identityKey(a.accountUuid, a.organizationUuid) === key)
    // The 2.3.0 slots: `{ role, replace }` names the account at that rank.
    const replaceId = opts.replaceId ?? (opts.role && opts.replace ? this.meta.accounts[rankOfRole(opts.role)]?.id : undefined)
    const holder = replaceId ? this.meta.accounts.find((a) => a.id === replaceId) : undefined
    if (replaceId && !holder) return this.res(false, 'not_found')
    if (opts.recaptureId) {
      const want = this.meta.accounts.find((a) => a.id === opts.recaptureId)
      if (!want) return this.res(false, 'not_found')
      if (existing !== want) return this.res(false, existing ? 'duplicate' : 'unknown_live_account')
    }
    // This login is saved as another account already: re-capture that one, never a second copy.
    if (existing && holder && existing !== holder) return this.res(false, 'duplicate')
    // The live grant already belongs to another account: never two copies of one grant.
    const fpOwner = this.byRt(tok.refresh ? sha(tok.refresh) : '')
    if (fpOwner && fpOwner.id !== existing?.id) return this.res(false, 'duplicate')
    if (!existing && !holder && this.meta.accounts.length >= MAX_CLAUDE_ACCOUNTS) return this.res(false, 'limit_reached')
    /** Where a new account goes: the replaced one's rank, else last. */
    let at = this.meta.accounts.length
    if (holder && holder !== existing) {
      at = this.rankOf(holder)
      await this.deps.vault.remove(holder.id).catch(() => undefined)
      // prev.bin may hold the replaced account's working login.
      await this.deps.vault.removePrevious().catch(() => undefined)
      this.forget(holder.id)
    }
    const now = this.now()
    const id = existing?.id ?? `acc_${randomBytes(6).toString('hex')}`
    const stored = claudeFiles.snapshotRaw(live.cred)
    try {
      await this.deps.vault.putSnapshot(id, { v: 1, credentialsRaw: stored, capturedAt: now })
    } catch (err) {
      console.warn('[accounts] capture failed:', errCode(err))
      return this.res(false, 'io')
    }
    const label = opts.label !== undefined ? cleanAccountLabel(opts.label) : (existing?.label ?? '')
    const sub = live.cred.claudeAiOauth?.subscriptionType
    const acc: VaultAccountMeta = {
      id,
      label,
      email: ident.email,
      accountUuid: ident.accountUuid,
      organizationUuid: ident.organizationUuid,
      organizationName: ident.organizationName,
      subscriptionType: typeof sub === 'string' && sub ? sub.slice(0, 64) : (existing?.subscriptionType ?? null),
      rateLimitTier: ident.rateLimitTier ?? existing?.rateLimitTier ?? null,
      capturedAt: now,
      updatedAt: now,
      identityConfirmed: ident.confirmed,
      needsRecapture: false,
      exhaustedUntil: existing?.exhaustedUntil ?? null,
      ...(existing?.lastUsage ? { lastUsage: existing.lastUsage } : {}),
    }
    if (existing) Object.assign(existing, acc)
    else this.meta.accounts.splice(Math.min(at, this.meta.accounts.length), 0, acc)
    this.setFingerprint(id, stored)
    this.tokenStates.set(id, 'ok')
    this.parked.delete(id)
    const prevActive = this.meta.activeId
    this.meta.activeId = id
    if (prevActive !== id) {
      this.meta.verify = null
      // The user signed in to it and saved it: the automatic return stops there.
      this.meta.anchorId = id
    }
    this.lastSeenHash = sha(live.raw)
    this.setLiveKnown()
    this.clearLockIfFixed()
    await this.persist()
    // The rows polled while this login was unknown or unverified were dropped
    // (onActiveUsage): fetch them now, not on the next poll, so the slot and
    // the policy have a reading at once.
    if (prevActive !== id || !this.usage.has(id)) void this.usageControl?.refreshActive().catch(() => undefined)
    return this.res(true)
  }

  private forget(id: string): void {
    this.meta.accounts = this.meta.accounts.filter((a) => a.id !== id)
    this.fp.delete(id)
    this.usage.delete(id)
    this.tokenStates.delete(id)
    this.parked.delete(id)
    if (this.meta.activeId === id) this.meta.activeId = null
    if (this.meta.anchorId === id) this.meta.anchorId = null
    if (this.parkedLast === id) this.parkedLast = null
    if (this.meta.verify?.to === id || this.meta.verify?.from === id) this.meta.verify = null
  }

  // --- switch ------------------------------------------------------------------

  switchTo(idOrRole: string, reason: ClaudeSwitchReason): Promise<AccountsOpRes> {
    return this.switchWith(idOrRole, reason, {})
  }

  private switchWith(idOrRole: string, reason: ClaudeSwitchReason, detail: { window?: '5h' | '7d'; percent?: number; exhaustedUntil?: number | null }): Promise<AccountsOpRes> {
    return this.run(async () => {
      if (this.disposed) return this.res(false, 'busy')
      const r = await this.switchInner(idOrRole, reason, detail)
      this.emitState(true)
      return r
    }, () => this.res(false, 'busy'))
  }

  private isLive(acc: VaultAccountMeta): boolean {
    return acc.id === this.meta.activeId && this.liveIdentity === 'known'
  }

  /** Why the live login must not be overwritten now, or null. */
  private liveBlock(): AccountsOpError | null {
    // A changed login we could not identify yet may hold the only valid tokens.
    if (this.liveUnverified) return 'identity_failed'
    if (this.liveIdentity === 'unknown') return 'unknown_live_account'
    return null
  }

  /**
   * The live file, read again after reconcileInner classified it, and only when
   * it still is that classified blob (lastSeenHash): a rotation or a /login
   * landing between the two reads is classified once more, then `null` (busy).
   * An unreadable file (locked, mid-write) is `null` too: nothing is written.
   */
  private async classifiedLive(): Promise<claudeFiles.LiveCredentials | null> {
    for (let i = 0; i < 2; i++) {
      const live = await this.files.readCredentials()
      if (live.kind === 'bad') return null
      if (this.liveKey(live) === this.lastSeenHash) return live
      if (i === 0) await this.reconcileInner(true)
    }
    return null
  }

  private async switchInner(idOrRole: string, reason: ClaudeSwitchReason, detail: { window?: '5h' | '7d'; percent?: number; exhaustedUntil?: number | null }): Promise<AccountsOpRes> {
    if (this.unsupportedReason === 'keychain') return this.res(false, 'unsupported')
    if (this.unsupportedReason) return this.res(false, 'encryption_unavailable')
    const target = this.resolve(idOrRole)
    if (!target) return this.res(false, 'not_found')
    if (target.needsRecapture) return this.res(false, 'locked')
    await this.reconcileInner(true)
    if (this.isLive(target)) return this.res(true)
    let blocked = this.liveBlock()
    if (blocked) return this.res(false, blocked)

    // Re-capture the account we leave: its live tokens are the only valid copy.
    const live = await this.classifiedLive()
    if (!live) return this.res(false, 'busy')
    // The second classification may have found an unknown or unverified login.
    blocked = this.liveBlock()
    if (blocked) return this.res(false, blocked)
    if (this.isLive(target)) return this.res(true)
    const leaving = this.meta.accounts.find((a) => a.id === this.meta.activeId)
    if (live.kind === 'ok' && leaving) {
      if (!(await this.recapture(leaving, live.cred))) return this.res(false, 'io')
    }
    const { snap, failed } = await this.deps.vault.readSnapshot(target.id)
    if (!snap) {
      target.needsRecapture = true
      if (failed) this.tokenStates.set(target.id, 'invalid')
      if (this.meta.autoPaused === null) this.meta.autoPaused = 'locked'
      await this.persist()
      this.fire({ kind: 'locked', auto: false, to: target.id, at: this.now() }, false)
      return this.res(false, 'locked')
    }
    if (live.kind === 'ok' || live.kind === 'empty') {
      await this.deps.vault.putPrevious(live.raw).catch((err: unknown) => console.warn('[accounts] saving the previous login failed:', errCode(err)))
    }
    // Right before the write the file must still be the blob captured above:
    // a refresh landing in between holds the only valid copy of its grant.
    const again = await this.files.readCredentials()
    if (this.liveKey(again) !== this.liveKey(live)) {
      await this.reconcileInner(true)
      return this.res(false, 'busy')
    }
    const merged = claudeFiles.mergeCredentials(live.kind === 'ok' || live.kind === 'empty' ? live.raw : null, snap.credentialsRaw)
    try {
      await this.files.writeCredentials(merged)
    } catch (err) {
      console.warn('[accounts] switch write failed:', errCode(err))
      return this.res(false, 'io')
    }
    const now = this.now()
    const from = this.meta.activeId
    this.lastSeenHash = sha(merged)
    this.meta.activeId = target.id
    this.meta.lastSwitch = { at: now, from, to: target.id, reason }
    // The account left at its limit stays out until its own reset.
    if (reason === 'auto_exhausted' && leaving) leaving.exhaustedUntil = detail.exhaustedUntil ?? null
    // The user's own pick: the automatic return never climbs above it.
    if (ANCHOR_REASONS.has(reason)) this.meta.anchorId = target.id
    this.meta.verify = { to: target.id, from, at: now, targetExpiresAt: tokenOf(claudeFiles.parseCredentials(snap.credentialsRaw)).expiresAt }
    this.setLiveKnown()
    this.pending = null
    this.policyMem.deferSince = null
    this.storeLastUsage()
    await this.persist()
    const auto = reason === 'auto_exhausted' || reason === 'auto_return'
    this.fire(
      { kind: 'switched', auto, from: from ?? undefined, to: target.id, reason, ...(detail.window ? { window: detail.window } : {}), ...(detail.percent !== undefined ? { percent: detail.percent } : {}), at: now },
      auto && this.cfg.alertOnSwitch,
    )
    void this.usageControl?.refreshActive().catch(() => undefined)
    // Claude may write the file at the same moment: look again shortly.
    if (this.verifyTimer) clearTimeout(this.verifyTimer)
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null
      void this.reconcile()
    }, this.deps.verifyDelayMs ?? VERIFY_MS)
    this.verifyTimer.unref?.()
    return this.res(true)
  }

  // --- other mutations -----------------------------------------------------------

  remove(id: string): Promise<AccountsOpRes> {
    return this.run(async () => {
      const acc = this.meta.accounts.find((a) => a.id === id)
      if (!acc) return this.res(false, 'not_found')
      await this.deps.vault.remove(id).catch(() => undefined)
      // prev.bin is only a recovery aid and may hold this account's working
      // login: a removed account leaves no copy behind.
      await this.deps.vault.removePrevious().catch(() => undefined)
      const wasActive = this.meta.activeId === id
      this.forget(id)
      this.clearLockIfFixed()
      if (this.meta.accounts.length === 0) {
        this.meta.autoPaused = null
        this.meta.lastSwitch = null
        this.meta.anchorId = null
        this.meta.verify = null
      }
      // The live login is now an unsaved one: the next look classifies it.
      if (wasActive) this.lastSeenHash = null
      await this.persist()
      if (wasActive) await this.reconcileInner(false)
      this.emitState(true)
      return this.res(true)
    }, () => this.res(false, 'busy'))
  }

  rename(id: string, label: string): Promise<AccountsOpRes> {
    return this.run(async () => {
      const acc = this.meta.accounts.find((a) => a.id === id)
      if (!acc) return this.res(false, 'not_found')
      acc.label = cleanAccountLabel(label)
      await this.persist()
      this.emitState(true)
      return this.res(true)
    }, () => this.res(false, 'busy'))
  }

  /** Make this account the first (the 2.3.0 "Set as primary"): a move to rank 0. */
  setPrimary(id: string): Promise<AccountsOpRes> {
    return this.move(id, 0)
  }

  /** Move one account to `to` (0-based, clamped); the others keep their relative order. */
  move(id: string, to: number): Promise<AccountsOpRes> {
    return this.run(async () => {
      const i = this.meta.accounts.findIndex((a) => a.id === id)
      if (i < 0) return this.res(false, 'not_found')
      if (!Number.isInteger(to)) return this.res(false, 'bad_request')
      const j = Math.max(0, Math.min(this.meta.accounts.length - 1, to))
      if (i === j) return this.applyOrder(null)
      const next = [...this.meta.accounts]
      const [acc] = next.splice(i, 1)
      next.splice(j, 0, acc)
      return this.applyOrder(next)
    }, () => this.res(false, 'busy'))
  }

  /** The whole priority order at once: every saved id exactly once (else bad_request). */
  reorder(ids: string[]): Promise<AccountsOpRes> {
    return this.run(async () => {
      const cur = this.meta.accounts
      const unique = new Set(ids)
      if (!Array.isArray(ids) || ids.length !== cur.length || unique.size !== ids.length || !cur.every((a) => unique.has(a.id))) {
        return this.res(false, 'bad_request')
      }
      const next = ids.map((id) => cur.find((a) => a.id === id) as VaultAccountMeta)
      return this.applyOrder(next.every((a, i) => a === cur[i]) ? null : next)
    }, () => this.res(false, 'busy'))
  }

  /** Inside run(): store a new order (null: unchanged), then publish (the badge's ranks and `other` change). */
  private async applyOrder(next: VaultAccountMeta[] | null): Promise<AccountsOpRes> {
    if (next) {
      this.meta.accounts = next
      await this.persist()
      // A pending switch or a block was decided on the old order.
      this.evaluate()
    }
    this.emitState(true)
    return this.res(true)
  }

  /** Clear a pause; `unknownAccount` / `noLogin` come back at once if the live login still is one. */
  resumeAuto(): Promise<AccountsOpRes> {
    return this.run(async () => {
      this.meta.autoPaused = null
      this.writeBacks = []
      this.policyMem.allExhaustedLatched = false
      this.lastSeenHash = null
      await this.reconcileInner(true)
      await this.persist()
      this.emitState(true)
      return this.res(true)
    }, () => this.res(false, 'busy'))
  }

  // --- usage and policy ----------------------------------------------------------

  private intervalMs(): number {
    return Math.max(30_000, this.deps.usageIntervalMs?.() ?? 60_000)
  }

  private parkedIntervalMs(): number {
    return Math.max(PARKED_MIN_MS, 5 * this.intervalMs())
  }

  /** Rows of the active account's poll (5h and 7d even when hidden). */
  onActiveUsage(rows: UsageRow[], at: number): void {
    const id = this.meta.activeId
    // An unidentified live login (liveUnverified) may be another account: its readings are not the active one's.
    if (!this.ready || !id || this.liveIdentity !== 'known' || this.liveUnverified) return
    const pick = (rid: string): { s: WindowSample; ok: boolean } | null => {
      const r = rows.find((x) => x.id === rid)
      if (!r) return null
      return { s: { percent: r.status === 'ok' ? r.percent : null, resetsAt: r.status === 'ok' ? (r.resetsAt ?? null) : null, at }, ok: r.status === 'ok' }
    }
    const f = pick('claude.5h')
    const w = pick('claude.7d')
    if (!f && !w) return
    const prev = this.usage.get(id)
    const okAll = (f?.ok ?? true) && (w?.ok ?? true)
    this.usage.set(id, {
      fiveHour: f?.ok ? f.s : (prev?.fiveHour ?? noSample()),
      sevenDay: w?.ok ? w.s : (prev?.sevenDay ?? noSample()),
      ok: okAll,
      source: 'live',
    })
    const expired = rows.some((r) => r.provider === 'claude' && r.status === 'expired')
    this.tokenStates.set(id, expired ? 'expired' : 'ok')
    this.evaluate()
    this.emitState()
  }

  private storeLastUsage(): void {
    for (const a of this.meta.accounts) {
      const u = this.usage.get(a.id)
      if (u) a.lastUsage = { fiveHour: u.fiveHour, sevenDay: u.sevenDay }
    }
  }

  /**
   * Usage of a parked account with its own unexpired access token (never
   * refreshed by us). At most one fetch per tick, the accounts in turn (round
   * robin after the one polled last), each at most every parkedIntervalMs.
   */
  async pollParked(): Promise<void> {
    if (!this.cfg.pollParked || this.parkedBusy || this.unsupportedReason || !this.ready) return
    if (this.deps.usageEnabled && !this.deps.usageEnabled()) return
    this.parkedBusy = true
    try {
      const now = this.now()
      const list = this.meta.accounts
      const after = list.findIndex((a) => a.id === this.parkedLast)
      const turn = [...list.slice(after + 1), ...list.slice(0, after + 1)]
      for (const acc of turn) {
        if (acc.id === this.meta.activeId || acc.needsRecapture) continue
        const st = this.parked.get(acc.id) ?? { nextAt: 0, stopped: false }
        this.parked.set(acc.id, st)
        if (st.stopped || now < st.nextAt) continue
        const snap = await this.deps.vault.getSnapshot(acc.id)
        const cred = snap ? claudeFiles.parseCredentials(snap.credentialsRaw) : null
        const tok = tokenOf(cred)
        if (!tok.access || tok.expiresAt === null || tok.expiresAt < now + PARKED_TOKEN_MARGIN_MS) {
          // A parked token is never refreshed by us: no fresh reading can come
          // until the account is live again (the policy estimates instead).
          st.stopped = true
          continue
        }
        // One fetch this tick, whatever it answers: the next tick asks the next account.
        this.parkedLast = acc.id
        const res = await (this.deps.fetchUsage ?? fetchClaudeUsage)(
          { claude5h: true, claude7d: true, claudeOpus7d: false, claudeSonnet7d: false },
          { readCred: async () => cred },
        )
        if (res.rows.length > 0 && res.rows.every((r) => r.status === 'expired')) {
          st.stopped = true
          this.tokenStates.set(acc.id, 'expired')
          break
        }
        if (res.rateLimited || res.rows.every((r) => r.status === 'error')) {
          st.nextAt = now + 2 * this.parkedIntervalMs()
          break
        }
        const row = (rid: string): WindowSample => {
          const r = res.rows.find((x) => x.id === rid && x.status === 'ok')
          return r ? { percent: r.percent, resetsAt: r.resetsAt ?? null, at: now } : noSample()
        }
        this.usage.set(acc.id, { fiveHour: row('claude.5h'), sevenDay: row('claude.7d'), ok: true, source: 'parked' })
        st.nextAt = now + this.parkedIntervalMs()
        break
      }
    } catch {
      /* next tick */
    } finally {
      this.parkedBusy = false
    }
  }

  private policyWindow(w: WindowSample | undefined): PolicyWindow {
    return { percent: w?.percent ?? null, resetsAt: parseIso(w?.resetsAt), at: w?.at ?? null }
  }

  /** Run the policy; a switch goes through switchTo with its auto reason. */
  evaluate(): void {
    if (this.evaluating || this.disposed || this.unsupportedReason || !this.ready) return
    const now = this.now()
    const activeFresh = 2 * this.intervalMs() + 30_000
    const parkedFresh = 2 * this.parkedIntervalMs() + 30_000
    const accounts: PolicyAccount[] = this.meta.accounts.map((a, rank) => {
      const u = this.usage.get(a.id)
      const isActive = a.id === this.meta.activeId
      const at = u ? Math.max(u.fiveHour.at ?? 0, u.sevenDay.at ?? 0) : 0
      const fresh = !!u && u.ok && at > 0 && now - at <= (isActive ? activeFresh : parkedFresh) && (isActive ? u.source === 'live' : true)
      // No fresh parked reading can come: its access token expired (or the poll stopped or is off).
      const stale = !isActive && !fresh && (!this.cfg.pollParked || this.parked.get(a.id)?.stopped === true || this.tokenStates.get(a.id) === 'expired')
      return {
        id: a.id,
        rank,
        exhaustedUntil: a.exhaustedUntil,
        fiveHour: this.policyWindow(u?.fiveHour),
        sevenDay: this.policyWindow(u?.sevenDay),
        fresh,
        stale,
        usable: !a.needsRecapture,
      }
    })
    const working = this.deps.statuses().filter((e) => (e.provider ?? 'claude') === 'claude' && e.state === 'working').length
    const mem: PolicyMemory = {
      ...this.policyMem,
      lastSwitchAt: this.meta.lastSwitch?.at ?? null,
      lastSwitchReason: this.meta.lastSwitch?.reason ?? null,
    }
    const out = decide({
      now,
      cfg: this.cfg,
      activeId: this.meta.activeId,
      anchorId: this.meta.anchorId,
      accounts,
      paused: this.meta.autoPaused !== null || this.liveIdentity !== 'known' || this.liveUnverified,
      workingClaude: working,
      mem,
    })
    this.policyMem.deferSince = out.mem.deferSince
    this.policyMem.allExhaustedLatched = out.mem.allExhaustedLatched
    const d = out.decision
    const prevPending = JSON.stringify(this.pending)
    const prevBlocked = this.blocked
    if (d.kind === 'switch') {
      this.pending = null
      this.blocked = null
      this.evaluating = true
      void this.switchWith(d.to, d.reason, { window: d.window, percent: d.percent, exhaustedUntil: d.exhaustedUntil }).finally(() => {
        this.evaluating = false
      })
      return
    }
    if (d.kind === 'defer') {
      this.pending = { to: d.to, reason: d.reason, since: this.policyMem.deferSince ?? now }
      this.blocked = null
    } else if (d.kind === 'blocked') {
      this.pending = null
      this.blocked = 'allExhausted'
      if (d.notify) {
        this.fire({ kind: 'allExhausted', auto: true, from: this.meta.activeId ?? undefined, at: now }, this.cfg.alertOnSwitch)
      }
    } else {
      this.pending = null
      this.blocked = null
    }
    if (prevPending !== JSON.stringify(this.pending) || prevBlocked !== this.blocked) this.emitState()
  }

  /** Pause reason, for the tests. */
  pausedReason(): ClaudeAutoPause | null {
    return this.meta.autoPaused
  }
}
