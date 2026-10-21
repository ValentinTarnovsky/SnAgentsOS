import { spawn, type IPty } from 'node-pty'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { delimiter, dirname } from 'path'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { HeadlessMetrics, PtyDataEvt, PtyExitEvt, PtyPromptResultEvt, PtyReattachRes, PtyRestartReq, PtyRestartRes, PtySpawnReq, PtySpawnRes, PtySubmitRes, ShellKind, TerminalEngineSettings } from '@shared/ipc-contract'
import type { AgentProvider, ClaudePaneState, SetupStep } from '@shared/types'
import { inputEffect, tuneReady } from '@shared/agentTune'
import { REPORTS_ONLY_RE } from '@shared/inputReports'
import { AGENT_ENV, CLI_ENV } from '@shared/brand'
import { appendPromptRef } from '@shared/agent-argv'
import {
  INITIAL_PROMPT_ENV,
  PROMPT_POLL_MS,
  PROMPT_READY_TIMEOUT_MS,
  SUBMIT_DELAY_MS,
  chooseDelivery,
  prepareSubmit,
  sanitizeInitialPrompt,
  type InitialPromptReq,
} from '@shared/initialPrompt'
import { shellKind as promptShellKind } from '@shared/shellKind'
import { CWD_MISSING } from '@shared/worktree-types'
import { cleanEnv, defaultShell, homeDir } from './shellResolver'
import { resolveShell } from './shellResolve'
import { ModeTracker } from './ModeTracker'
import { sanitizeQueries } from './ansiSanitize'
import { HeadlessMirror } from './HeadlessMirror'
import { MAX_FILE_BYTES, capBytes, countLines, scrollOff, trimPersistAnsi, type PersistSnapshot } from './ScrollbackStore'
import { DEFAULT_ENGINE, REPLAY_LINES, mirrorScrollback, normalizeEngine } from '@shared/terminalEngine'
import { OSC133_PROMPT_START, SHELL_INTEGRATION_ENV, buildIntegrationArgs, shouldIntegrate, stripOsc133 } from './powershellIntegration'

interface Entry {
  pty: IPty
  /** Stable renderer-owned id; lets the renderer reattach across remounts. */
  paneId: string
  /** Raw chunks accumulated since the last flush (joined once at flush). */
  buf: string[]
  timer: ReturnType<typeof setTimeout> | null
  /** Bounded recent-output ring, replayed into a fresh terminal on reattach. */
  history: string[]
  historyBytes: number
  /** The ring dropped its oldest chunk at least once (its head may be mid-sequence). */
  historyTruncated: boolean
  /** Chunks the ring has dropped so far: history[i] is chunk number historyDropped + i. */
  historyDropped: number
  /**
   * Chunk number where the output after the last effective resize starts, or
   * null (never resized). The ring replay drops what came before (E3-FR-22).
   */
  resizeMark: number | null
  /** DEC private modes seen on the full output stream (E6-FR-33). */
  modes: ModeTracker
  /** Family of the launched shell (E6-FR-32). */
  shellKind: ShellKind
  /** The cwd handed to node-pty (E5-FR-05 spawnCwd: where a resume must relaunch). */
  spawnCwd: string
  /** Set by kill() so the exit it causes is not reported as natural (E6-FR-34). */
  killing: boolean
  /** False while the owning workspace is hidden (output is throttled). */
  active: boolean
  /** True while a setup (expect/send) sequence is running for this pty. */
  setupActive: boolean
  /** Set on teardown so an in-flight setup sequence aborts. */
  cancelled: boolean
  /** Rolling tail of recent output the setup runner matches `waitFor` against. */
  scratch: string
  /** Notified (no args) on each new chunk while a setup waiter is pending. */
  onChunk: (() => void) | null
  /** Settles the pending `waitFor` promise (match, timeout, or cancel). */
  setupResolve: (() => void) | null
  /** Pending setup timer (delay or waitFor timeout), cleared on cancel. */
  setupTimer: ReturnType<typeof setTimeout> | null
  /** Outbound bytes still queued for the pty, drained in paced chunks. */
  writeQueue: string
  /** Timer pacing the writeQueue drain (null while idle). */
  writeTimer: ReturnType<typeof setTimeout> | null
  /** Headless emulator fed with every flush (E6-FR-01); null until the snapshot mode creates it. */
  mirror: HeadlessMirror | null
  /** The mirror threw once: this pty stays on ring + ModeTracker replays for good. */
  mirrorFailed: boolean
  /** Output arrived since the last scrollback checkpoint (E6-FR-09 clears it). */
  dirty: boolean
  /** Bumped on every change a snapshot can see (flush with data, resize, unicode, scrollback). */
  gen: number
  /** Last replay snapshot and the gen it was taken at (several phones or a reattach in one tick). */
  snapCache: { gen: number; data: string } | null
  /** Waiting for writeQueue to drain (a submit's Enter, E8-FR-02a); false = the pty went away. */
  drained: Array<(alive: boolean) => void>
  /** Epoch ms of the last output chunk (quiet fallback, `wait`). */
  lastOutputAt: number
  /** Epoch ms of the last submit with Enter (E8-FR-02). */
  lastSubmitAt: number
  /**
   * v2.3 (agentTune): input that did not end in Enter / Ctrl+C reached the
   * pty since the last one, so the agent's input box may hold a draft. Keys
   * answering an open request (state `action`, Enter included) and terminal
   * reports neither set nor clear it. A tune with Enter refuses (`busy`)
   * while it is set.
   */
  draft: boolean
  /** Last character of the previous non-report write: a `\` typed before its Enter (inputEffect). */
  inputTail: string
  /** Initial prompt still to deliver (E8-FR-02b), consumed once. */
  prompt: { req: InitialPromptReq; mode: 'argv' | 'gate' } | null
  /** Gate poll timer. */
  promptTimer: ReturnType<typeof setTimeout> | null
  /** Launched with the PowerShell integration (E6-FR-25). */
  integrated: boolean
  /** Types the initial command on the first prompt mark (E6-FR-30); null when not waiting. */
  readyWait: (() => void) | null
  /** Last bytes of the previous chunk, so a mark split across chunks is still seen. */
  readyTail: string
}

/** Agent readiness as StatusManager derives it (E8-FR-02b gate). */
export type AgentStateFn = (paneId: string) => { state: ClaudePaneState; precise: boolean; provider?: AgentProvider; pendingCount?: number; ended?: boolean } | null

/** Main-side listener of initial prompt outcomes (the renderer gets pty:promptResult). */
export type PromptResultListener = (evt: PtyPromptResultEvt) => void

/** Output is coalesced and flushed at ~120Hz for the visible workspace. */
const FLUSH_MS = 8
/** Hidden workspaces flush far slower, their xterms can't paint anyway. */
const HIDDEN_FLUSH_MS = 250
/** Cap on a single IPC payload (split larger bursts across frames). */
const MAX_CHUNK = 256 * 1024
/**
 * Windows ConPTY silently drops bytes when one write exceeds its small input
 * buffer, so a large paste arrives truncated (only the tail survives). Feed the
 * pty in capped, paced chunks instead. Normal typing (a write at or under the
 * cap with nothing queued) skips the queue, so keystroke latency is unchanged.
 */
const WRITE_CHUNK = 4 * 1024
const WRITE_PACE_MS = 4
/** Replay ring-buffer size per pty. */
const HISTORY_CAP = 256 * 1024
/**
 * A restart seed enters the new ring in pieces this size, so new output pushes
 * out its oldest lines a piece at a time instead of the whole kept output at
 * once (a seed of a full ring sits right at HISTORY_CAP).
 */
const SEED_CHUNK = 16 * 1024
/** Recent-output tail kept for setup `waitFor` matching (bounds memory). */
const SCRATCH_CAP = 16 * 1024
/**
 * How far into a truncated ring trimRingHead looks for a clean start. Past it
 * the head is kept as is rather than dropping a whole ring of CR-only output.
 */
const HEAD_SCAN = 8 * 1024
/** Timing samples kept for the headless p95 metrics (E6-FR-07). */
const METRIC_SAMPLES = 512
/** Cadence of the SNAOS_DEBUG_TERMINAL console line. */
const DEBUG_METRICS_MS = 10_000
/** How long the shell is given to print its first prompt before setup begins. */
const SHELL_SETTLE_MS = 350
/** With the PowerShell integration, the most the initial command waits for the first prompt mark (E6-FR-30). */
const READY_MARKER_TIMEOUT_MS = 2500
/** Default cap on waiting for a `waitFor` match before proceeding anyway. */
const DEFAULT_WAIT_MS = 15000

/**
 * Builds a predicate for a `waitFor` pattern. `/body/flags` is treated as a
 * regex (bad patterns fall back to a literal match); everything else is a
 * case-insensitive substring test so "password:" matches "Password:".
 */
function buildMatcher(pattern: string): (text: string) => boolean {
  const re = pattern.match(/^\/(.*)\/([a-z]*)$/is)
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2])
      return (text) => rx.test(text)
    } catch {
      /* malformed regex, fall through to substring */
    }
  }
  const needle = pattern.toLowerCase()
  return (text) => text.toLowerCase().includes(needle)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Clear screen + scrollback + home: the head of a ring replay cut at a resize (E3-FR-22). */
export const REPLAY_CLEAR = '\x1b[2J\x1b[3J\x1b[H'

/** An alt-screen DECSET (?47 / ?1047 / ?1049, alone or inside a list). */
const ALT_ENTER_RE = /\x1b\[\?(?:[\d;]*;)?(?:47|1047|1049)(?:;[\d;]*)?h/

/**
 * Start of a replay built from the ring. Once the ring has dropped chunks, its
 * first chunk can begin inside an escape sequence (`;2;255m...` printed as
 * text) or mid-line, so the replay starts after the first line break, or at the
 * first ESC when there is no line break near the head. An untruncated ring is
 * the exact stream start and is returned whole.
 */
export function trimRingHead(ring: string, truncated: boolean): string {
  if (!truncated || !ring) return ring
  const limit = Math.min(ring.length, HEAD_SCAN)
  const nl = ring.indexOf('\n')
  if (nl >= 0 && nl < limit) return ring.slice(nl + 1)
  const esc = ring.indexOf('\x1b')
  if (esc >= 0 && esc < limit) return ring.slice(esc)
  return ring
}

/**
 * Turns off what a dead or replaced program may have left on (E6-FR-18/19):
 * SGR, alt screen, every mouse protocol and encoding, bracketed paste,
 * application cursor keys, focus reports, and shows the cursor. Written after
 * the kept output, so a restarted pane (desktop and phone) starts clean.
 */
export const SOFT_RESET =
  '\x1b[0m\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1l\x1b[?25h\x1b[?1004l'

/** Last output of a pane whose pty ended on its own (E6-FR-20), kept for phones and restarts. */
export interface ExitedPane {
  /** The dead pty, so a later kill() of that id (pane closed) drops the record. */
  ptyId: string
  /** Clean ring + SOFT_RESET, ready to replay. */
  data: string
  cols: number
  rows: number
  exitCode: number
  at: number
  /** Output arrived since the last scrollback save (carried over from the pty, E6-FR-09). */
  dirty?: boolean
}

/**
 * The restart separator line: gray, control characters stripped from the
 * label. With `rows`, the scroll-off follows: the new ConPTY clears the
 * screen on start (ESC[2J), which would erase the last screen of kept output
 * and the separator itself.
 */
export function restartTail(label: string, rows?: number): string {
  const line = `${SOFT_RESET}\r\n\x1b[2m--- ${label.replace(/[\x00-\x1f\x7f-\x9f]/g, '')} ---\x1b[0m\r\n`
  return rows && rows > 0 ? line + scrollOff(rows) : line
}

/** Restores a pane's saved scrollback: the seed for `rows`, or null (E6-FR-11). */
export type SeedSource = (paneId: string, rows: number) => string | null

/** Bounded timing samples (ms) with a p95 read (E6-FR-07). */
class Samples {
  private readonly buf: number[] = []
  private next = 0
  add(ms: number): void {
    if (this.buf.length < METRIC_SAMPLES) this.buf.push(ms)
    else this.buf[this.next] = ms
    this.next = (this.next + 1) % METRIC_SAMPLES
  }
  p95(): number {
    if (this.buf.length === 0) return 0
    const sorted = [...this.buf].sort((a, b) => a - b)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 1000) / 1000
  }
}

const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6

/** How a pty ended, as seen by each sink (E6-FR-34). */
export interface PtyExitInfo {
  /** The pty was still the live one bound to its pane. */
  current: boolean
  /** The process ended on its own (not kill/killAll/restart or a failed spawn). */
  natural: boolean
  /** A spawn refused before node-pty ran: its cwd is gone (a pane worktree deleted by hand, E7-FR-36). */
  error?: typeof CWD_MISSING
}

/**
 * An extra consumer of pty lifecycle + output, fed alongside the renderer
 * (remote-control sessions mirror terminals through one of these). Callbacks
 * run synchronously on the pty event path and must never throw or block.
 */
export interface PtySink {
  id: string
  /** A pty was bound to paneId (spawn or restart => NEW ptyId, rebind). */
  onSpawn(ptyId: string, paneId: string): void
  /** Coalesced output, same bytes the renderer receives (unsplit). */
  onData(ptyId: string, paneId: string, data: string): void
  /**
   * The pty exited (or failed to spawn). Fired after the final data flush,
   * before teardown, for every exit; `info` tells natural current exits apart.
   */
  onExit(ptyId: string, paneId: string, exitCode: number, info: PtyExitInfo): void
  /**
   * Optional (E3-FR-12): an effective resize of the pty (cols or rows really
   * changed), after the output emitted at the old size was flushed to sinks.
   */
  onResize?(ptyId: string, paneId: string, cols: number, rows: number): void
  /**
   * Optional (E2-FR-48): user input is about to reach the pty through
   * write() (desktop keyboard, phone `input`, a phone answer card, a global
   * prompt). Setup sequences write to the pty directly and never land here.
   * v2.3: `origin` is 'auto' for writes nobody typed (the initial-prompt gate,
   * `snaos send`, a scheduled prompt, the resume nudge, an agent-end chip, a
   * global prompt or race paste and its Enter): they still invalidate answer
   * cards but never acknowledge attention.
   */
  onUserInput?(ptyId: string, paneId: string, data: string, origin: PtyInputOrigin): void
}

/** v2.3: who wrote to a pty: the user (keyboard, phone input, answer cards) or an automation. */
export type PtyInputOrigin = 'user' | 'auto'

/**
 * Owns every node-pty instance. The renderer never touches native modules;
 * it drives ptys exclusively through this manager via IPC.
 *
 * Beyond raw I/O it maintains, per pane: a replay ring buffer (so a remounted
 * or reloaded renderer can rebind without respawning), an active flag for
 * hidden-workspace output throttling, and flow control for backpressure.
 */
export class PtyManager {
  private readonly entries = new Map<string, Entry>()
  private readonly byPane = new Map<string, string>()
  private seq = 0
  /** Extra output listeners (remote-control sessions) fed alongside the renderer. */
  private readonly sinks = new Map<string, PtySink>()
  /** Panes that flush at the fast cadence even while hidden (remote viewers). */
  private readonly forcedFast = new Set<string>()
  /** Ptys paused via renderer backpressure; auto-resumed if the renderer dies. */
  private readonly pausedByRenderer = new Set<string>()
  /** Fired after byPane changes (spawn/dispose) so remote can refresh `running`. */
  private onRunningChange: (() => void) | null = null
  /** paneId -> epoch ms of the last input written (desktop or phone), for hibernation (E5-FR-25). */
  private readonly lastInput = new Map<string, number>()
  /** paneId -> last output of a pty that ended on its own (E6-FR-20); one per pane. */
  private readonly exited = new Map<string, ExitedPane>()
  /** Headless mirror policy, Unicode and persistence lines (E6-FR-01/06/08), set by setEngine. */
  private engine: TerminalEngineSettings = { ...DEFAULT_ENGINE }
  private readonly parseMs = new Samples()
  private readonly snapshotMs = new Samples()
  private bytesParsed = 0
  private snapshotCacheHits = 0
  private debugTimer: ReturnType<typeof setInterval> | null = null
  /** Saved scrollback loader (E6-FR-11), wired by main once the store exists. */
  private seedSource: SeedSource | null = null
  /** Panes that already had their first spawn in this app session: the seed is consumed once. */
  private readonly seedConsumed = new Set<string>()

  private readonly promptListeners = new Set<PromptResultListener>()
  /**
   * Whether ConPTY relays the prompt mark in this process (E6-FR-30): null
   * until a pane tells, true once a mark arrived, false after a pane timed out
   * (every later pane goes back to the 350 ms timer).
   */
  private oscReadySupported: boolean | null = null

  /**
   * `agentState` is a lazy closure (StatusManager is built after this): the
   * gate of an initial prompt only submits on a precise idle/done.
   * `platform` is the OS the shells run on: it decides the initial prompt
   * delivery (a `%` forces the gate on win32 only) and the PowerShell
   * integration. Always process.platform in the app; tests inject it to pin
   * one OS's rules whatever the host.
   */
  constructor(private readonly getSender: () => WebContents | null,
    private readonly statusEnv: (ptyId: string, paneId: string, cwd: string, workspaceId?: string) => Record<string, string> = () => ({}),
    private readonly agentState: AgentStateFn = () => null,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Number of live ptys. */
  get count(): number {
    return this.entries.size
  }

  /**
   * A pane's spawn. The first one in this app session with
   * `restoreScrollback` starts from the pane's saved history (E6-FR-11): the
   * seed enters the ring and the mirror before any sink hears of the pty, and
   * comes back for the renderer to write before it binds.
   */
  spawn(req: PtySpawnReq): PtySpawnRes {
    const { restoreScrollback, ...spawnReq } = req
    const firstSpawn = !this.seedConsumed.has(req.paneId)
    this.seedConsumed.add(req.paneId)
    const seed = firstSpawn && restoreScrollback === true ? this.loadSeed(req.paneId, req.rows) : ''
    let res: PtySpawnRes
    try {
      res = this.spawnSeeded(spawnReq, seed)
    } catch (error) {
      // The shell never ran: the next spawn of this pane may still restore.
      if (firstSpawn) this.seedConsumed.delete(req.paneId)
      throw error
    }
    if (seed) res.seed = seed
    return res
  }

  private loadSeed(paneId: string, rows: number): string {
    if (!this.seedSource || !this.persistEnabled()) return ''
    try {
      return this.seedSource(paneId, rows > 0 ? rows : 24) ?? ''
    } catch (error) {
      console.warn(`[pty] could not restore the saved history of pane ${paneId}: ${String(error)}`)
      return ''
    }
  }

  /**
   * spawn() with `seed` pre-loaded into the new ring, before any sink hears of
   * the pty, so a phone's replay already carries it (E6-FR-19). The seed never
   * feeds the ModeTracker: the new program starts with default modes.
   */
  private spawnSeeded(req: PtySpawnReq, seed: string): PtySpawnRes {
    const ptyId = `pty-${++this.seq}-${randomUUID()}`
    // A configured shell that does not exist falls back to the OS default (E6-FR-32).
    const resolved = resolveShell(req.shell, defaultShell())
    if (resolved.warning) console.warn(`[pty] shell not found: ${resolved.warning.requested}, using ${resolved.shell}`)
    const shell = resolved.shell
    // Initial prompt (E8-FR-02b, D1): decided here with the resolved shell.
    // `argv` puts the sanitized text in SNAOS_INITIAL_PROMPT and appends its
    // reference to the agent command; otherwise the gate types it later.
    let initial = req.initialCommand?.trim()
    const promptReq = validPrompt(req.initialPrompt)
    let prompt: Entry['prompt'] = null
    let promptRejected = false
    const promptEnv: Record<string, string> = {}
    if (promptReq) {
      const kind = promptShellKind(shell, this.platform)
      const argv =
        !!initial &&
        chooseDelivery({ text: promptReq.text, shell: kind, platform: this.platform, hasSetup: !!req.setup?.length, launchKind: req.launchKind ?? 'other' }) === 'argv'
      if (argv && initial) {
        promptEnv[INITIAL_PROMPT_ENV] = sanitizeInitialPrompt(promptReq.text)
        initial = appendPromptRef(initial, kind)
        prompt = { req: promptReq, mode: 'argv' }
      } else if (promptReq.mode === 'argvOnly') promptRejected = true
      else prompt = { req: promptReq, mode: 'gate' }
    }
    const env = cleanEnv({ ...req.env, ...this.statusEnv(ptyId, req.paneId, req.cwd || homeDir(), req.workspaceId), [AGENT_ENV.consoleId]: req.paneId, [AGENT_ENV.ptyId]: ptyId })
    // Never inherited from a preset's env: only an argv delivery sets it.
    delete env[INITIAL_PROMPT_ENV]
    Object.assign(env, promptEnv)
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    if (env[AGENT_ENV.codexShim]) env[pathKey] = env[AGENT_ENV.codexShim] + delimiter + (env[pathKey] ?? '')
    // snaos CLI (E8-FR-13): its bin folder first, so `snaos` resolves in every shell.
    if (env[CLI_ENV.cli]) env[pathKey] = dirname(env[CLI_ENV.cli]) + delimiter + (env[pathKey] ?? '')
    // E7-FR-36 defense: a cwd deleted outside the app (a pane worktree) is a
    // typed failure instead of node-pty's opaque one; the renderer shows the
    // "worktree was deleted" card for it.
    if (req.cwd && !existsSync(req.cwd)) {
      for (const sink of this.sinks.values()) {
        try { sink.onExit(ptyId, req.paneId, -1, { current: false, natural: false, error: CWD_MISSING }) } catch { /* release prepared integrations */ }
      }
      throw Object.assign(new Error(`${CWD_MISSING}: ${req.cwd}`), { code: CWD_MISSING })
    }
    // PowerShell integration (E6-FR-25): only a bare PowerShell on Windows.
    const integrated = shouldIntegrate({ shell, args: req.args, platform: this.platform, enabled: this.engine.shellIntegration === true })
    if (integrated) env[SHELL_INTEGRATION_ENV] = '1'
    let proc: IPty
    try { proc = spawn(shell, integrated ? buildIntegrationArgs() : (req.args ?? []), {
      name: 'xterm-256color',
      cols: req.cols > 0 ? req.cols : 80,
      rows: req.rows > 0 ? req.rows : 24,
      cwd: req.cwd || homeDir(),
      // Reserved IDs bind hooks to this exact terminal generation.
      env,
    }) } catch (error) {
      for (const sink of this.sinks.values()) {
        try { sink.onExit(ptyId, req.paneId, -1, { current: false, natural: false }) } catch { /* release prepared integrations */ }
      }
      throw error
    }

    const entry: Entry = {
      pty: proc,
      paneId: req.paneId,
      buf: [],
      timer: null,
      history: [],
      historyBytes: 0,
      historyTruncated: false,
      historyDropped: 0,
      resizeMark: null,
      modes: new ModeTracker(),
      shellKind: resolved.shellKind,
      spawnCwd: req.cwd || homeDir(),
      killing: false,
      active: true,
      setupActive: false,
      cancelled: false,
      scratch: '',
      onChunk: null,
      setupResolve: null,
      setupTimer: null,
      writeQueue: '',
      writeTimer: null,
      mirror: null,
      mirrorFailed: false,
      dirty: false,
      gen: 0,
      snapCache: null,
      drained: [],
      lastOutputAt: 0,
      lastSubmitAt: 0,
      draft: false,
      inputTail: '',
      prompt,
      promptTimer: null,
      integrated,
      readyWait: null,
      readyTail: '',
    }
    for (let i = 0; i < seed.length; i += SEED_CHUNK) this.pushHistory(entry, seed.slice(i, i + SEED_CHUNK))
    this.entries.set(ptyId, entry)
    this.byPane.set(req.paneId, ptyId)
    // 'auto' with persistence keeps a mirror from the spawn (E6-FR-01), and so
    // does any spawn with a seed outside 'off' (E6-FR-11/19): it takes the
    // whole seed, which the 256 KB ring may already have cut. Before the sinks
    // hear of the pty, so a phone's replay already comes from it.
    if (this.mirrorAtSpawn() || (seed && this.engine.snapshotMode !== 'off')) this.ensureMirror(ptyId, entry, seed)
    // A respawn supersedes whatever the previous pty left (E6-FR-20).
    this.exited.delete(req.paneId)
    for (const sink of this.sinks.values()) {
      try {
        sink.onSpawn(ptyId, req.paneId)
      } catch {
        /* a sink must never break a spawn */
      }
    }
    // byPane gained a pane: let remote re-broadcast so its `running` dot flips.
    this.onRunningChange?.()

    if (promptRejected) this.emitPrompt(req.paneId, 'not_delivered')
    if (req.setup && req.setup.length > 0) {
      // Drive the expect/send sequence (e.g. SSH login), then type the model.
      void this.runSetup(ptyId, entry, req.setup, initial)
    } else if (initial || prompt) {
      // No setup: original behavior, type the model command once the shell has
      // settled. A bare CR is exactly what pressing Enter sends; CRLF makes
      // PowerShell emit a spurious ">>" continuation.
      const typeInitial = (): void => {
        if (entry.setupTimer) clearTimeout(entry.setupTimer)
        entry.setupTimer = null
        entry.readyWait = null
        if (entry.cancelled) return
        if (initial) {
          try {
            proc.write(initial + '\r')
          } catch {
            /* pty may have exited */
          }
        }
        this.afterInitialCommand(ptyId, entry)
      }
      if (integrated && this.oscReadySupported !== false) {
        // E6-FR-30: a slow profile (2 s) still gets the command after its
        // prompt. The first mark types it; the timeout types it anyway and
        // sends every later pane of this process back to the 350 ms timer.
        entry.readyWait = typeInitial
        entry.setupTimer = setTimeout(() => {
          if (entry.readyWait) this.oscReadySupported = false
          typeInitial()
        }, READY_MARKER_TIMEOUT_MS)
      } else {
        entry.setupTimer = setTimeout(typeInitial, SHELL_SETTLE_MS)
      }
    }

    proc.onData((data) => {
      entry.lastOutputAt = Date.now()
      entry.buf.push(data)
      this.pushHistory(entry, data)
      entry.modes.feed(data)
      if (entry.readyWait) {
        // A plain string search (E6-FR-30), with the previous chunk's tail.
        const hay = entry.readyTail + data
        if (hay.includes(OSC133_PROMPT_START)) {
          this.oscReadySupported = true
          entry.readyTail = ''
          entry.readyWait()
        } else entry.readyTail = hay.slice(-(OSC133_PROMPT_START.length - 1))
      }
      if (entry.setupActive) {
        // Feed the setup runner the same bytes the renderer sees, in order.
        entry.scratch += data
        if (entry.scratch.length > SCRATCH_CAP) entry.scratch = entry.scratch.slice(-SCRATCH_CAP)
        entry.onChunk?.()
      }
      if (entry.timer === null) {
        const fast = entry.active || this.forcedFast.has(entry.paneId)
        entry.timer = setTimeout(() => this.flush(ptyId), fast ? FLUSH_MS : HIDDEN_FLUSH_MS)
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      this.flush(ptyId)
      this.send(CH.PTY_EXIT, { ptyId, exitCode, signal, natural: !entry.killing } satisfies PtyExitEvt)
      // An exit that kill() caused is not natural, even when node-pty fires it
      // synchronously from inside kill().
      this.dispose(ptyId, exitCode, !entry.killing)
    })

    const res: PtySpawnRes = { ptyId, shellKind: resolved.shellKind }
    if (resolved.warning) res.warning = resolved.warning
    return res
  }

  /** Rebind to a live pty for paneId, returning its id + replay history. */
  reattach(paneId: string): PtyReattachRes | null {
    const ptyId = this.byPane.get(paneId)
    if (!ptyId) return null
    const entry = this.entries.get(ptyId)
    if (!entry) return null
    // Drain anything pending so post-subscribe output isn't a duplicate of replay.
    this.flush(ptyId)
    const replay = this.snapshotReplay(ptyId, entry)
    return { ptyId, replay, cols: entry.pty.cols, rows: entry.pty.rows, shellKind: entry.shellKind }
  }

  /**
   * In-place restart (E6-FR-18/19). The kept output is the dead pty's
   * `exited` record, or the live pty's clean ring; the live one is killed as
   * not natural (phones get no `exit`). The new pty's ring is seeded with
   * output + tail, and the renderer writes only `tail` over what it already
   * shows, so desktop and phone end up identical. Throws when the spawn fails;
   * the output then stays in `exited` for phones.
   */
  restart(req: PtyRestartReq, label: string): PtyRestartRes {
    const { fallbackDefaultShell, ...spawnReq } = req
    if (fallbackDefaultShell) delete spawnReq.shell
    // The initial prompt is spent once: a restart never sends it again (E8-FR-02).
    delete spawnReq.initialPrompt
    const oldId = this.byPane.get(req.paneId)
    const old = oldId ? this.entries.get(oldId) : undefined
    let content = this.exited.get(req.paneId)?.data ?? ''
    let cols = req.cols, rows = req.rows, exitCode = this.exited.get(req.paneId)?.exitCode ?? -1
    if (oldId && old) {
      this.flush(oldId)
      content = this.keptOutput(old)
      cols = old.pty.cols
      rows = old.pty.rows
      old.killing = true
      try {
        old.pty.kill()
      } catch {
        /* already gone */
      }
      this.dispose(oldId, 0, false)
    }
    const tail = restartTail(label, rows > 0 ? rows : 24)
    try {
      const res = this.spawnSeeded(spawnReq, content + tail)
      const out: PtyRestartRes = { ptyId: res.ptyId, tail, shellKind: res.shellKind }
      if (res.warning) out.warning = res.warning
      return out
    } catch (error) {
      // Nothing is bound to the pane now: keep its output visible to phones.
      if (content && !this.exited.has(req.paneId)) {
        this.exited.set(req.paneId, { ptyId: oldId ?? '', data: content, cols, rows, exitCode, at: Date.now() })
        this.onRunningChange?.()
      }
      throw error
    }
  }

  /**
   * What a restart or an exited replay shows, + SOFT_RESET: the mirror's normal
   * buffer when there is one (E6-FR-19), else the clean ring (head trimmed,
   * queries removed).
   */
  private keptOutput(entry: Entry): string {
    if (entry.mirror) {
      try {
        const t0 = nowMs()
        const snap = entry.mirror.snapshot({ scrollback: mirrorScrollback(this.engine), purpose: 'persist' })
        this.snapshotMs.add(nowMs() - t0)
        return snap.data + SOFT_RESET
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    return sanitizeQueries(trimRingHead(entry.history.join(''), entry.historyTruncated)) + SOFT_RESET
  }

  /** Last output of a pane whose pty ended on its own, or null (E6-FR-20). */
  getExited(paneId: string): ExitedPane | null {
    return this.exited.get(paneId) ?? null
  }

  /** paneId -> exit code of every pane whose pty ended on its own (E6-FR-38). */
  exitedPaneCodes(): Map<string, number> {
    return new Map([...this.exited].map(([paneId, rec]) => [paneId, rec.exitCode]))
  }

  /**
   * Replay text for a fresh terminal (E6-FR-33): the modes still active that may
   * have scrolled out of the ring, then the ring with a clean head and without
   * the queries a receiving xterm would answer into the live shell.
   */
  private replayOf(entry: Entry): string {
    // E3-FR-22 fallback (no headless mirror): bytes laid out for an older size
    // repaint as garbage at the current one, so a ring that spans a resize
    // replays a clear plus only what came after it (TUIs redraw on SIGWINCH).
    const mark = entry.resizeMark
    if (mark !== null && mark > entry.historyDropped) {
      const tail = sanitizeQueries(entry.history.slice(mark - entry.historyDropped).join(''))
      return entry.modes.rehydrate(!ALT_ENTER_RE.test(tail)) + REPLAY_CLEAR + tail
    }
    const body = sanitizeQueries(trimRingHead(entry.history.join(''), entry.historyTruncated))
    // The body is a suffix of the stream: when it enters the alt screen itself,
    // that is the last alt transition, so the prefix must not do it earlier.
    return entry.modes.rehydrate(!ALT_ENTER_RE.test(body)) + body
  }

  write(ptyId: string, data: string, origin: PtyInputOrigin = 'user'): void {
    const entry = this.entries.get(ptyId)
    if (!entry || !data) return
    this.lastInput.set(entry.paneId, Date.now())
    this.trackDraft(entry, data)
    // E2-FR-48: input invalidates the agent's outstanding answer cards before it lands.
    for (const sink of this.sinks.values()) {
      if (!sink.onUserInput) continue
      try {
        sink.onUserInput(ptyId, entry.paneId, data, origin)
      } catch {
        /* a sink must never block typing */
      }
    }
    // Fast path: a small write with nothing queued goes straight to the pty so
    // interactive typing keeps zero added latency.
    if (entry.writeQueue.length === 0 && data.length <= WRITE_CHUNK) {
      try {
        entry.pty.write(data)
      } catch {
        /* pty may have exited */
      }
      return
    }
    // Large input, or input arriving behind a backlog: queue it and drain in
    // capped, paced chunks. Appending preserves byte order against whatever is
    // already queued.
    entry.writeQueue += data
    this.drainWrites(ptyId)
  }

  /**
   * v2.3: keeps `entry.draft` (see Entry). Any origin counts: an automation
   * that inserts without Enter (a global prompt) leaves a draft too. Input
   * while a request is open (state `action`) goes to its dialog, not to the
   * box: it changes nothing, so an Enter that answers a permission keeps a
   * follow-up typed before it. The state is read only when the flag would flip.
   */
  private trackDraft(entry: Entry, data: string): void {
    const effect = inputEffect(data, (d) => REPORTS_ONLY_RE.test(d), entry.inputTail)
    if (effect === 'report') return
    entry.inputTail = data.slice(-1)
    const draft = effect === 'typed'
    if (draft === entry.draft || this.agentState(entry.paneId)?.state === 'action') return
    entry.draft = draft
  }

  /** Drain an entry's writeQueue to its pty, one capped chunk per pace tick. */
  private drainWrites(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry || entry.writeTimer) return
    const pump = (): void => {
      const e = this.entries.get(ptyId)
      if (!e) return
      e.writeTimer = null
      if (e.writeQueue.length === 0) {
        this.fireDrained(e, true)
        return
      }
      let end = Math.min(WRITE_CHUNK, e.writeQueue.length)
      // Never split a surrogate pair across two writes: node-pty would encode
      // each half on its own, corrupting that character.
      const lead = e.writeQueue.charCodeAt(end - 1)
      if (end > 1 && end < e.writeQueue.length && lead >= 0xd800 && lead <= 0xdbff) end--
      const chunk = e.writeQueue.slice(0, end)
      e.writeQueue = e.writeQueue.slice(end)
      try {
        e.pty.write(chunk)
      } catch {
        e.writeQueue = '' // pty exited: drop the rest
        this.fireDrained(e, false)
        return
      }
      if (e.writeQueue.length > 0) e.writeTimer = setTimeout(pump, WRITE_PACE_MS)
      else this.fireDrained(e, true)
    }
    pump()
  }

  /** Runs `cb` once the entry's writeQueue is empty (right away when it already is). */
  private whenDrained(entry: Entry, cb: (alive: boolean) => void): void {
    if (entry.writeQueue.length === 0 && !entry.writeTimer) cb(!entry.cancelled)
    else entry.drained.push(cb)
  }

  private fireDrained(entry: Entry, alive: boolean): void {
    if (entry.drained.length === 0) return
    const cbs = entry.drained
    entry.drained = []
    for (const cb of cbs) {
      try {
        cb(alive)
      } catch {
        /* a waiter must never break the pump */
      }
    }
  }

  /**
   * The shared delivery path (E8-FR-02a): the text with its line breaks
   * normalized to `\r`, wrapped in bracketed paste when it has inner breaks
   * and the pty enabled DECSET 2004 (refused with `multiline_unsafe`, writing
   * nothing, when it did not). With `enter`, the `\r` goes SUBMIT_DELAY_MS
   * after the write queue drained, not after queueing, so a 64 KB text paced
   * in 4 KB chunks still gets its Enter after its last byte.
   * `readyFor` (v2.3, agentTune): with `enter`, the pane's agent must be that
   * provider, precise and at rest (tuneReady) with no draft in its input
   * box, else `busy` and nothing is written.
   */
  submit(ptyId: string, text: string, enter: boolean, forcePaste = false, origin: PtyInputOrigin = 'user', readyFor?: AgentProvider): Promise<PtySubmitRes> {
    const entry = this.entries.get(ptyId)
    if (!entry || entry.cancelled) return Promise.resolve({ ok: false, error: 'not_running' })
    if (enter && readyFor && (entry.draft || !tuneReady(this.agentState(entry.paneId), readyFor))) return Promise.resolve({ ok: false, error: 'busy' })
    const prepared = prepareSubmit(text, entry.modes.bracketedPaste, forcePaste)
    if (!prepared.ok) return Promise.resolve(prepared)
    if (prepared.data) this.write(ptyId, prepared.data, origin)
    if (!enter) return Promise.resolve({ ok: true })
    return new Promise((resolve) => {
      this.whenDrained(entry, (alive) => {
        if (!alive) {
          resolve({ ok: false, error: 'not_running' })
          return
        }
        setTimeout(() => {
          if (this.entries.get(ptyId) !== entry || entry.cancelled) {
            resolve({ ok: false, error: 'not_running' })
            return
          }
          this.write(ptyId, '\r', origin)
          entry.lastSubmitAt = Date.now()
          resolve({ ok: true })
        }, SUBMIT_DELAY_MS)
      })
    })
  }

  /** submit() into the pane's live pty, when `ptyId` is unknown or stale. */
  submitToPane(ptyId: string, paneId: string | undefined, text: string, enter: boolean, origin: PtyInputOrigin = 'user', readyFor?: AgentProvider): Promise<PtySubmitRes> {
    const id = ptyId && this.entries.has(ptyId) ? ptyId : paneId ? this.byPane.get(paneId) : undefined
    return id ? this.submit(id, text, enter, false, origin, readyFor) : Promise.resolve({ ok: false, error: 'not_running' })
  }

  /** Whether the pane's live pty has bracketed paste on, or null without one. */
  bracketedPasteOf(paneId: string): boolean | null {
    const ptyId = this.byPane.get(paneId)
    const entry = ptyId ? this.entries.get(ptyId) : undefined
    return entry ? entry.modes.bracketedPaste : null
  }

  /** Epoch ms of the pane's last submit with Enter (E8-FR-02), or undefined. */
  lastSubmitAt(paneId: string): number | undefined {
    const ptyId = this.byPane.get(paneId)
    const at = ptyId ? this.entries.get(ptyId)?.lastSubmitAt : undefined
    return at || undefined
  }

  /**
   * The pane's live pty ring as raw text, or null without one (`snaos read`
   * fallback, E8-FR-17). Reads only: no flush, no mirror, no state change.
   */
  tail(paneId: string): string | null {
    const ptyId = this.byPane.get(paneId)
    const entry = ptyId ? this.entries.get(ptyId) : undefined
    return entry ? trimRingHead(entry.history.join(''), entry.historyTruncated) : null
  }

  /** Epoch ms of the pane's last output chunk, or undefined. */
  lastOutputAt(paneId: string): number | undefined {
    const ptyId = this.byPane.get(paneId)
    const at = ptyId ? this.entries.get(ptyId)?.lastOutputAt : undefined
    return at || undefined
  }

  /** Main-side listener of initial prompt outcomes. Returns an unsubscribe function. */
  addPromptListener(cb: PromptResultListener): () => void {
    this.promptListeners.add(cb)
    return () => {
      this.promptListeners.delete(cb)
    }
  }

  private emitPrompt(paneId: string, result: PtyPromptResultEvt['result']): void {
    const evt: PtyPromptResultEvt = { paneId, result }
    this.send(CH.PTY_PROMPT_RESULT, evt)
    for (const cb of this.promptListeners) {
      try {
        cb(evt)
      } catch {
        /* a listener must never break delivery */
      }
    }
  }

  /**
   * The agent command was typed (or there was none): an `argv` prompt is
   * delivered now, a gate one starts polling for a precise ready signal.
   */
  private afterInitialCommand(ptyId: string, entry: Entry): void {
    const prompt = entry.prompt
    if (!prompt || entry.cancelled) return
    if (prompt.mode === 'argv') {
      entry.prompt = null
      entry.lastSubmitAt = Date.now()
      this.emitPrompt(entry.paneId, 'sent_argv')
      return
    }
    const deadline = Date.now() + PROMPT_READY_TIMEOUT_MS
    const tick = (): void => {
      entry.promptTimer = null
      if (entry.cancelled || entry.prompt !== prompt) return
      const state = this.agentState(entry.paneId)
      // Only a precise signal (SessionStart hook, Codex bridge start) may send
      // Enter: a title-only `idle` could be a trust dialog or a login screen.
      if (state?.precise && (state.state === 'idle' || state.state === 'done')) {
        entry.prompt = null
        void this.submit(ptyId, prompt.req.text, prompt.req.enter, false, 'auto').then((res) =>
          this.emitPrompt(entry.paneId, res.ok ? 'sent_gate' : res.error === 'not_running' ? 'dropped_exit' : 'not_delivered'),
        )
        return
      }
      if (Date.now() >= deadline) {
        entry.prompt = null
        if (!entry.modes.bracketedPaste) {
          this.emitPrompt(entry.paneId, 'not_delivered')
          return
        }
        // Inserted as a paste, never submitted: the user reviews and presses Enter.
        void this.submit(ptyId, prompt.req.text, false, true, 'auto').then((res) =>
          this.emitPrompt(entry.paneId, res.ok ? 'inserted_unconfirmed' : res.error === 'not_running' ? 'dropped_exit' : 'not_delivered'),
        )
        return
      }
      entry.promptTimer = setTimeout(tick, PROMPT_POLL_MS)
    }
    tick()
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.entries.get(ptyId)
    if (entry && cols > 0 && rows > 0) {
      const changed = entry.pty.cols !== cols || entry.pty.rows !== rows
      // Output emitted at the old size reaches the ring, the mirror and every
      // sink before the resize, so the mark and fitState come after it (E3-FR-12/22).
      if (changed) this.flush(ptyId)
      try {
        entry.pty.resize(cols, rows)
      } catch {
        /* pty may have already exited */
      }
      // The mirror follows every resize, phone-fit included (E6-FR-06).
      if (entry.mirror) {
        try {
          entry.mirror.resize(cols, rows)
        } catch (error) {
          this.dropMirror(entry, error)
        }
        entry.gen++
      }
      if (changed) {
        entry.resizeMark = entry.historyDropped + entry.history.length
        for (const sink of this.sinks.values()) {
          try {
            sink.onResize?.(ptyId, entry.paneId, cols, rows)
          } catch {
            /* a sink must never break the resize */
          }
        }
      }
    }
  }

  kill(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) {
      // The renderer kills a dead pty's id when its pane goes away: drop the
      // output kept for that pane (E6-FR-20), unless a newer exit replaced it.
      for (const [paneId, rec] of this.exited) {
        if (rec.ptyId !== ptyId) continue
        this.exited.delete(paneId)
        this.onRunningChange?.()
      }
      return
    }
    entry.killing = true
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
    this.dispose(ptyId, 0, false)
  }

  killAll(): void {
    // Drain buffered output before tearing down so the last bytes aren't lost.
    for (const id of [...this.entries.keys()]) {
      this.flush(id)
      this.kill(id)
    }
  }

  /**
   * Kill the ptys of these panes by paneId (E4-FR-36): the renderer's
   * registry can be empty after a reload, main's byPane never is. A pane that
   * goes away also drops the output kept for its natural exit (E6-FR-20).
   * Returns how many live ptys were killed; unknown panes are a no-op. Every
   * live pty of the pane goes, not only the byPane one: an unmount never
   * kills, so a superseded pty would otherwise outlive its pane.
   */
  killPanes(paneIds: string[]): number {
    const gone = new Set(paneIds)
    let killed = 0
    for (const [ptyId, entry] of [...this.entries]) {
      if (!gone.has(entry.paneId)) continue
      this.kill(ptyId)
      killed++
    }
    for (const paneId of gone) if (this.exited.delete(paneId)) this.onRunningChange?.()
    return killed
  }

  /**
   * After the renderer hydrates (E4-FR-36): kill every pty whose pane is no
   * longer in the store (deleted while the UI was gone, or a config that lost
   * it), and forget exit records of panes that no longer exist.
   */
  reconcile(livePaneIds: string[]): number {
    const live = new Set(livePaneIds)
    const known = new Set(this.exited.keys())
    for (const entry of this.entries.values()) known.add(entry.paneId)
    const gone = [...known].filter((id) => !live.has(id))
    return this.killPanes(gone)
  }

  /** Mark which panes are in the visible workspace; others throttle output. */
  setActive(paneIds: string[]): void {
    const activeSet = new Set(paneIds)
    for (const [ptyId, entry] of this.entries) {
      const nowActive = activeSet.has(entry.paneId)
      const wasActive = entry.active
      entry.active = nowActive
      // On reveal, paint whatever was buffered while hidden, immediately.
      if (nowActive && !wasActive) this.flush(ptyId)
    }
  }

  /** Backpressure: pause/resume a pty when the renderer can't keep up. */
  setFlow(ptyId: string, pause: boolean): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    try {
      if (pause) {
        entry.pty.pause()
        this.pausedByRenderer.add(ptyId)
      } else {
        entry.pty.resume()
        this.pausedByRenderer.delete(ptyId)
      }
    } catch {
      /* pty may have exited */
    }
  }

  /**
   * Resume every pty paused by renderer backpressure. Called when the renderer
   * goes away (reload / crash) so remote viewers aren't starved forever by a
   * pause that will never be lifted.
   */
  resumeRendererPaused(): void {
    for (const ptyId of [...this.pausedByRenderer]) this.setFlow(ptyId, false)
  }

  /** Register an extra output listener (remote-control sessions). */
  addSink(sink: PtySink): void {
    this.sinks.set(sink.id, sink)
  }

  removeSink(id: string): void {
    this.sinks.delete(id)
  }

  /**
   * Replace the set of panes remote viewers are watching. Those panes flush at
   * the fast cadence even when their desktop pane is hidden; panes that just
   * became fast flush immediately (mirror of the reveal flush in setActive).
   */
  setForcedFast(paneIds: Iterable<string>): void {
    const next = new Set(paneIds)
    const newlyFast = [...next].filter((paneId) => !this.forcedFast.has(paneId))
    this.forcedFast.clear()
    for (const paneId of next) this.forcedFast.add(paneId)
    for (const paneId of newlyFast) {
      const ptyId = this.byPane.get(paneId)
      if (ptyId) this.flush(ptyId)
    }
  }

  /** cwd node-pty got for the pane's live pty (E5 spawnCwd), or undefined. */
  getSpawnCwd(paneId: string): string | undefined {
    const ptyId = this.byPane.get(paneId)
    return ptyId ? this.entries.get(ptyId)?.spawnCwd : undefined
  }

  /** Epoch ms of the last input written to the pane (desktop or phone), or undefined. */
  lastInputAt(paneId: string): number | undefined {
    return this.lastInput.get(paneId)
  }

  /**
   * Kill every pty of the pane and wait (at most timeoutMs) until their
   * processes are gone, so Windows releases the handles a folder delete needs
   * (E7-FR-30). Resolves either way; the caller retries on a busy file.
   */
  async killPaneAndWait(paneId: string, timeoutMs = 3000): Promise<void> {
    const pids = [...this.entries.values()]
      .filter((e) => e.paneId === paneId)
      .map((e) => e.pty.pid)
      .filter((pid): pid is number => typeof pid === 'number' && pid > 0)
    this.killPanes([paneId])
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        return (e as { code?: unknown }).code === 'EPERM'
      }
    }
    const deadline = Date.now() + timeoutMs
    while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  }

  /** Live pty id bound to a pane, or null. */
  ptyIdForPane(paneId: string): string | null {
    return this.byPane.get(paneId) ?? null
  }

  /** Live size of a pane's pty, else of its exited record, else null (E3-FR-20). */
  sizeOf(paneId: string): { cols: number; rows: number } | null {
    const ptyId = this.byPane.get(paneId)
    const entry = ptyId ? this.entries.get(ptyId) : undefined
    if (entry) return { cols: entry.pty.cols, rows: entry.pty.rows }
    const exited = this.exited.get(paneId)
    return exited ? { cols: exited.cols, rows: exited.rows } : null
  }

  /** Pane ids that currently have a live pty (drives snapshot `running`). */
  runningPaneIds(): string[] {
    return [...this.byPane.keys()]
  }

  /**
   * Initial screen for a new remote subscriber: drain pending output to the
   * current listeners first (so the ring is the exact prefix of what follows),
   * then return the replay (replayOf) + live size. Callers must add their subscription in
   * the same synchronous block to avoid a gap or overlap with live `out` data.
   */
  getReplay(paneId: string): { ptyId: string; replay: string; cols: number; rows: number } | null {
    const ptyId = this.byPane.get(paneId)
    if (!ptyId) return null
    const entry = this.entries.get(ptyId)
    if (!entry) return null
    this.flush(ptyId)
    const replay = this.snapshotReplay(ptyId, entry)
    return { ptyId, replay, cols: entry.pty.cols, rows: entry.pty.rows }
  }

  // --- Headless mirror (E6-FR-01..07, FR-35) ---------------------------------

  /**
   * Applies the engine settings pushed by the renderer (and read from the
   * config at startup). 'off' drops every mirror; 'auto' with persistence gives
   * every live pty one; Unicode and the scrollback size reach the live mirrors.
   */
  setEngine(raw: unknown): void {
    const next = normalizeEngine(raw)
    this.engine = next
    for (const [ptyId, entry] of this.entries) {
      if (next.snapshotMode === 'off') {
        if (entry.mirror) this.disposeMirror(entry)
        continue
      }
      if (!entry.mirror && this.mirrorAtSpawn()) this.ensureMirror(ptyId, entry)
      if (!entry.mirror) continue
      try {
        entry.mirror.setUnicode(next.unicode11)
        entry.mirror.setScrollback(mirrorScrollback(next))
        entry.gen++
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    this.syncDebugTimer()
  }

  /** The engine settings in force (normalized). */
  getEngine(): TerminalEngineSettings {
    return { ...this.engine }
  }

  /** Instrumentation for AppMetrics.headless (E6-FR-07). */
  headlessMetrics(): HeadlessMetrics {
    let panes = 0
    for (const entry of this.entries.values()) if (entry.mirror) panes++
    return {
      panes,
      parseMsP95: this.parseMs.p95(),
      snapshotMsP95: this.snapshotMs.p95(),
      bytesParsed: this.bytesParsed,
      snapshotCacheHits: this.snapshotCacheHits,
    }
  }

  /** 'auto' creates the mirror at spawn while persistence is on; otherwise on the first replay. */
  private mirrorAtSpawn(): boolean {
    return this.engine.snapshotMode === 'auto' && this.engine.persist
  }

  /**
   * Creates the pty's mirror if the mode allows it, seeded with `seed` when
   * given, else with what a ring replay would show (mode rehydration first,
   * then the clean ring, E6-FR-02/33). Pending output is flushed first so the
   * ring and the mirror never both get the same bytes.
   */
  private ensureMirror(ptyId: string, entry: Entry, seed?: string): HeadlessMirror | null {
    if (entry.mirror || entry.mirrorFailed || this.engine.snapshotMode === 'off') return entry.mirror
    if (seed === undefined) this.flush(ptyId)
    try {
      const mirror = new HeadlessMirror({
        cols: entry.pty.cols > 0 ? entry.pty.cols : 80,
        rows: entry.pty.rows > 0 ? entry.pty.rows : 24,
        scrollback: mirrorScrollback(this.engine),
        unicode11: this.engine.unicode11,
      })
      entry.mirror = mirror
      const initial = seed ?? this.replayOf(entry)
      if (initial) this.writeMirror(entry, initial)
      entry.gen++
      entry.snapCache = null
    } catch (error) {
      this.dropMirror(entry, error)
    }
    return entry.mirror
  }

  /** Feeds the mirror, timing the parse (writeSync is synchronous). */
  private writeMirror(entry: Entry, data: string): void {
    const mirror = entry.mirror
    if (!mirror) return
    const t0 = nowMs()
    mirror.write(data)
    this.parseMs.add(nowMs() - t0)
    this.bytesParsed += data.length
  }

  /**
   * The replay for a fresh terminal: the mirror's snapshot (cached while no
   * output arrived), or the ring replay in 'off' and after a mirror failure.
   */
  private snapshotReplay(ptyId: string, entry: Entry): string {
    const mirror = this.ensureMirror(ptyId, entry)
    if (mirror) {
      if (entry.snapCache && entry.snapCache.gen === entry.gen) {
        this.snapshotCacheHits++
        return entry.snapCache.data
      }
      try {
        const t0 = nowMs()
        const { data } = mirror.snapshot({ scrollback: REPLAY_LINES, purpose: 'replay' })
        this.snapshotMs.add(nowMs() - t0)
        entry.snapCache = { gen: entry.gen, data }
        return data
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    return this.replayOf(entry)
  }

  private disposeMirror(entry: Entry): void {
    const mirror = entry.mirror
    entry.mirror = null
    entry.snapCache = null
    try {
      mirror?.dispose()
    } catch {
      /* already torn down */
    }
  }

  /** A mirror that threw: back to ring + ModeTracker for this pty, logged once. */
  private dropMirror(entry: Entry, error: unknown): void {
    this.disposeMirror(entry)
    if (!entry.mirrorFailed) console.warn(`[pty] headless mirror failed for pane ${entry.paneId}, using the raw ring: ${String(error)}`)
    entry.mirrorFailed = true
  }

  /** SNAOS_DEBUG_TERMINAL=1 prints the headless metrics to main's console while mirrors are on. */
  private syncDebugTimer(): void {
    const want = process.env.SNAOS_DEBUG_TERMINAL === '1' && this.engine.snapshotMode !== 'off'
    if (want && !this.debugTimer) {
      this.debugTimer = setInterval(() => console.log('[pty] headless', JSON.stringify(this.headlessMetrics())), DEBUG_METRICS_MS)
      this.debugTimer.unref?.()
    } else if (!want && this.debugTimer) {
      clearInterval(this.debugTimer)
      this.debugTimer = null
    }
  }

  // --- Saved scrollback (E6-FR-08..13, 36, 37) -----------------------------

  /** Wires the saved scrollback loader (main, once ScrollbackStore exists). */
  setSeedSource(source: SeedSource | null): void {
    this.seedSource = source
  }

  /** Persistence on and a snapshot mode other than 'off' (E6-FR-01/08). */
  persistEnabled(): boolean {
    return this.engine.persist && this.engine.snapshotMode !== 'off'
  }

  /** Lets the pane's next spawn restore again (closed and reopened in this session). */
  forgetSeed(paneId: string): void {
    this.seedConsumed.delete(paneId)
  }

  /** After killAll(): the next window is a new session that restores again (macOS). */
  resetSeeds(): void {
    this.seedConsumed.clear()
  }

  /** Drains every pty's pending output to the renderer, sinks and mirror. */
  flushAll(): void {
    for (const ptyId of [...this.entries.keys()]) this.flush(ptyId)
  }

  /** Panes with output since their last save: the live pty of each pane, and exited ones. */
  dirtyPaneIds(): string[] {
    const ids: string[] = []
    for (const [paneId, ptyId] of this.byPane) {
      const entry = this.entries.get(ptyId)
      if (entry && (entry.dirty || entry.buf.length > 0)) ids.push(paneId)
    }
    for (const [paneId, rec] of this.exited) if (rec.dirty && !this.byPane.has(paneId)) ids.push(paneId)
    return ids
  }

  /** A failed save: the pane goes back on the next checkpoint's list. */
  markDirty(paneId: string): void {
    const ptyId = this.byPane.get(paneId)
    const entry = ptyId ? this.entries.get(ptyId) : undefined
    if (entry) entry.dirty = true
    else {
      const rec = this.exited.get(paneId)
      if (rec) rec.dirty = true
    }
  }

  /**
   * What a save writes for the pane (E6-FR-09): the normal buffer only, no
   * modes and no alt screen, cut to `persistLines` rows and 1 MB, without
   * trailing blank lines. From the mirror when there is one; otherwise (lazy,
   * a failed mirror, an exited pane) from a temporary mirror fed with the
   * ring or the exited record and dropped right after. Clears the dirty flag.
   */
  takePersist(paneId: string): PersistSnapshot | null {
    if (!this.persistEnabled()) return null
    const ptyId = this.byPane.get(paneId)
    const entry = ptyId ? this.entries.get(ptyId) : undefined
    if (ptyId && entry) {
      this.flush(ptyId)
      entry.dirty = false
      if (entry.mirror) {
        try {
          return this.persistOf(entry.mirror)
        } catch (error) {
          this.dropMirror(entry, error)
        }
      }
      return this.persistVia(entry.pty.cols, entry.pty.rows, this.replayOf(entry))
    }
    const rec = this.exited.get(paneId)
    if (!rec) return null
    rec.dirty = false
    return this.persistVia(rec.cols, rec.rows, rec.data)
  }

  /**
   * "Clear saved history" (one pane or all): what the next save could bring
   * back is dropped too. The mirror loses its scrollback (ED3, the screen
   * stays) and nothing is dirty, so a later save holds only newer output.
   */
  clearPersisted(paneId?: string): void {
    for (const [ptyId, entry] of this.entries) {
      if (paneId !== undefined && entry.paneId !== paneId) continue
      this.flush(ptyId)
      const mirror = this.ensureMirror(ptyId, entry)
      if (mirror) {
        try {
          this.writeMirror(entry, '\x1b[3J')
          entry.gen++
        } catch (error) {
          this.dropMirror(entry, error)
        }
      }
      entry.dirty = false
    }
    for (const [id, rec] of this.exited) if (paneId === undefined || id === paneId) rec.dirty = false
  }

  private persistVia(cols: number, rows: number, data: string): PersistSnapshot | null {
    let mirror: HeadlessMirror | null = null
    try {
      mirror = new HeadlessMirror({
        cols: cols > 0 ? cols : 80,
        rows: rows > 0 ? rows : 24,
        scrollback: mirrorScrollback(this.engine),
        unicode11: this.engine.unicode11,
      })
      if (data) mirror.write(data)
      return this.persistOf(mirror)
    } catch (error) {
      console.warn(`[pty] could not snapshot a pane for saving: ${String(error)}`)
      return null
    } finally {
      try {
        mirror?.dispose()
      } catch {
        /* already gone */
      }
    }
  }

  private persistOf(mirror: HeadlessMirror): PersistSnapshot {
    const t0 = nowMs()
    let scrollback = Math.max(0, this.engine.persistLines - mirror.rows)
    let ansi = ''
    // Over 1 MB (truecolor-heavy output): serialize fewer rows instead of cutting mid-style.
    for (let round = 0; round < 4; round++) {
      ansi = trimPersistAnsi(mirror.snapshot({ scrollback, purpose: 'persist' }).data)
      const bytes = Buffer.byteLength(ansi, 'utf8')
      if (bytes <= MAX_FILE_BYTES || scrollback === 0) break
      scrollback = Math.floor(scrollback * (MAX_FILE_BYTES / bytes) * 0.9)
    }
    ansi = capBytes(ansi)
    this.snapshotMs.add(nowMs() - t0)
    return { ansi, cols: mirror.cols, rows: mirror.rows, lines: countLines(ansi) }
  }

  /**
   * Runs an expect/send sequence on a freshly spawned pty, then types the model
   * command. Each step optionally waits for the terminal to print `waitFor`
   * (with a timeout fallback) before sending its text, so an interactive
   * prompt like "password:" is answered automatically. Lives in main so it
   * survives renderer remounts and reads the same byte stream as the terminal.
   */
  private async runSetup(ptyId: string, entry: Entry, steps: SetupStep[], initialCommand?: string): Promise<void> {
    try {
      await this.runSetupSteps(entry, steps, initialCommand)
    } finally {
      // A gate prompt starts once the agent command went out (or the sequence ended).
      if (!entry.cancelled) this.afterInitialCommand(ptyId, entry)
    }
  }

  private async runSetupSteps(entry: Entry, steps: SetupStep[], initialCommand?: string): Promise<void> {
    entry.setupActive = true
    try {
      // Let the shell print its first prompt before we touch it.
      await sleep(SHELL_SETTLE_MS)
      for (const step of steps) {
        if (entry.cancelled) return
        if (step.waitFor && step.waitFor.trim()) {
          await this.waitForOutput(entry, step.waitFor.trim(), step.timeoutMs ?? DEFAULT_WAIT_MS)
        }
        if (entry.cancelled) return
        await sleep(step.delayMs ?? 120)
        if (entry.cancelled) return
        try {
          entry.pty.write(step.noEnter ? step.send : step.send + '\r')
        } catch {
          return // pty exited mid-sequence
        }
        // Only match the response to THIS step against the next waitFor.
        entry.scratch = ''
      }
      if (initialCommand) {
        if (entry.cancelled) return
        // Give the post-setup shell (often a remote one) a beat to be ready.
        await sleep(steps.length ? 400 : SHELL_SETTLE_MS)
        if (entry.cancelled) return
        try {
          entry.pty.write(initialCommand + '\r')
        } catch {
          /* pty exited */
        }
      }
    } finally {
      entry.setupActive = false
      entry.onChunk = null
      entry.scratch = ''
    }
  }

  /**
   * Resolves when `entry.scratch` matches `pattern`, or after `timeoutMs`. The
   * OSC 133 marks are stripped first (E6-FR-31): an anchored `/> $/` still
   * matches a prompt that ends in a mark.
   */
  private waitForOutput(entry: Entry, pattern: string, timeoutMs: number): Promise<void> {
    const test = buildMatcher(pattern)
    const matches = (text: string): boolean => test(stripOsc133(text))
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (entry.setupTimer) {
          clearTimeout(entry.setupTimer)
          entry.setupTimer = null
        }
        entry.onChunk = null
        entry.setupResolve = null
        resolve()
      }
      if (entry.cancelled || matches(entry.scratch)) {
        finish()
        return
      }
      entry.setupResolve = finish
      entry.setupTimer = setTimeout(finish, timeoutMs)
      entry.onChunk = () => {
        if (matches(entry.scratch)) finish()
      }
    })
  }

  private pushHistory(entry: Entry, data: string): void {
    entry.history.push(data)
    entry.historyBytes += data.length
    while (entry.historyBytes > HISTORY_CAP && entry.history.length > 1) {
      const dropped = entry.history.shift()
      if (dropped) entry.historyBytes -= dropped.length
      entry.historyTruncated = true
      entry.historyDropped++
    }
  }

  private flush(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.buf.length === 0) return
    const data = entry.buf.join('')
    entry.buf = []
    entry.dirty = true
    entry.gen++
    // The mirror parses the burst before any sink sees it (E6-FR-02), so a
    // snapshot taken right after a flush is the exact prefix of what follows.
    if (entry.mirror) {
      try {
        this.writeMirror(entry, data)
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    // Sinks get the unsplit burst; MAX_CHUNK framing is an IPC-only concern.
    for (const sink of this.sinks.values()) {
      try {
        sink.onData(ptyId, entry.paneId, data)
      } catch {
        /* a sink must never break renderer delivery */
      }
    }
    if (data.length <= MAX_CHUNK) {
      this.send(CH.PTY_DATA, { ptyId, data } satisfies PtyDataEvt)
      return
    }
    // Oversized burst: split into renderer-digestible frames.
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      this.send(CH.PTY_DATA, { ptyId, data: data.slice(i, i + MAX_CHUNK) } satisfies PtyDataEvt)
    }
  }

  private dispose(ptyId: string, exitCode: number, natural: boolean): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    // Abort any in-flight setup sequence: unblock a pending waiter so its async
    // runner wakes, sees `cancelled`, and returns without writing to a dead pty.
    entry.cancelled = true
    entry.setupActive = false
    entry.onChunk = null
    const resolveWait = entry.setupResolve
    entry.setupResolve = null
    if (resolveWait) resolveWait()
    if (entry.setupTimer) clearTimeout(entry.setupTimer)
    entry.setupTimer = null
    entry.readyWait = null
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.writeTimer) clearTimeout(entry.writeTimer)
    entry.writeTimer = null
    entry.writeQueue = ''
    this.fireDrained(entry, false)
    if (entry.promptTimer) clearTimeout(entry.promptTimer)
    entry.promptTimer = null
    // A prompt still waiting for its agent goes with the pty (E8-FR-02b).
    if (entry.prompt) {
      entry.prompt = null
      this.emitPrompt(entry.paneId, 'dropped_exit')
    }
    this.pausedByRenderer.delete(ptyId)
    const removed = this.byPane.get(entry.paneId) === ptyId
    if (removed) this.byPane.delete(entry.paneId)
    // Keep the last output of a shell that ended on its own (E6-FR-20): phones
    // that subscribe later see it instead of a spinner, and a restart reuses it.
    if (removed && natural) {
      this.exited.set(entry.paneId, { ptyId, data: this.keptOutput(entry), cols: entry.pty.cols, rows: entry.pty.rows, exitCode, at: Date.now(), dirty: entry.dirty })
    }
    for (const sink of this.sinks.values()) {
      try { sink.onExit(ptyId, entry.paneId, exitCode, { current: removed, natural }) } catch { /* sink teardown must not block PTY cleanup */ }
    }
    this.entries.delete(ptyId)
    // The mirror lives until the pty is gone (E6-FR-01); keptOutput above used it last.
    this.disposeMirror(entry)
    // byPane lost a pane: let remote re-broadcast so its `running` dot clears
    // even on a natural shell exit (which never triggers a renderer state push).
    if (removed) this.onRunningChange?.()
  }

  /**
   * Register a callback fired whenever the live pane->pty table changes (a pty
   * spawns or exits). Remote-control uses it to re-broadcast pane `running`
   * state to phones without waiting on a renderer-driven snapshot push.
   */
  setRunningChangeListener(cb: (() => void) | null): void {
    this.onRunningChange = cb
  }

  private send(channel: string, payload: PtyDataEvt | PtyExitEvt | PtyPromptResultEvt): void {
    const wc = this.getSender()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}

/** A usable initial prompt from IPC (text 1..16384 after trim), or null. */
function validPrompt(raw: unknown): InitialPromptReq | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.text !== 'string' || !r.text.trim() || r.text.length > 16384) return null
  return { text: r.text, enter: r.enter !== false, mode: r.mode === 'argvOnly' ? 'argvOnly' : 'auto' }
}
