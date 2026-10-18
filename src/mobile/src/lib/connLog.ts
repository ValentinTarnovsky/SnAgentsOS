// Adaptado de stablyai/orca (MIT) - mobile/src/diagnostics/connection-log-redaction.ts
/**
 * Connection log of the phone (E2-FR-35): a ring of the last 200 transitions
 * of the socket state machine, mirrored to sessionStorage (`snagentsos.diag`)
 * with a 1s debounce so it survives a reload of the tab and stays out of
 * localStorage. Every line is redacted BEFORE it enters the ring, so neither
 * the memory copy, the stored copy, the screen nor the copied report can hold
 * the device secret, an HMAC, a nonce or the pairing code.
 *
 * Next to the ring lives the small reactive state the diagnostics screen and
 * the pairing log read (lastClose, RTT, retries, the 25s pairing ceiling).
 * It is its own zustand store so the main store stays untouched.
 */
import { create } from 'zustand'
import { BRAND } from '@shared/brand'
import { redact as sharedRedact } from '@shared/redact'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /** Epoch ms. */
  t: number
  level: LogLevel
  msg: string
}

export const LOG_CAPACITY = 200
export const LOG_STORAGE_KEY = `${BRAND.mobileStoragePrefix}diag`
export const LOG_PERSIST_DEBOUNCE_MS = 1000
/** The stored copy stays under this many characters (NFR: < 40KB). */
export const LOG_MAX_STORED_CHARS = 38000
const MAX_MSG = 240

const REDACTED = '<redacted>'

/** Field names whose value is a credential or a one-time proof. */
const SECRET_FIELDS = ['secret', 'hmac', 'proof', 'clientNonce', 'nonce', 'token', 'pairCode']

/**
 * Scrub one log line. Field values (`secret=`, `"hmac":"..."`), the pairing
 * code (`pairCode=`, `code=` only on pair lines, `#pair=`) and every hex run of
 * 32+ characters become `<redacted>`. `close=1006` and other numbers are kept.
 * The shared redact() then runs as the defense-in-depth pass, keeping IPs so
 * the log still shows which address the phone dialed.
 */
export function redact(text: string): string {
  let out = String(text ?? '')
  for (const field of SECRET_FIELDS) {
    // key=value, key: value, "key":"value" (case-insensitive key).
    const re = new RegExp(`(["']?\\b${field}\\b["']?\\s*[=:]\\s*["']?)([^\\s"'&,;}]+)`, 'gi')
    out = out.replace(re, (_m, head: string) => head + REDACTED)
  }
  if (/\bpair/i.test(out)) {
    out = out.replace(/(\bcode\s*[=:]\s*["']?)([^\s"'&,;}]+)/gi, (_m, head: string) => head + REDACTED)
  }
  out = out.replace(/#pair=[^\s&]+/gi, `#pair=${REDACTED}`)
  out = out.replace(/\b[0-9a-f]{32,}\b/gi, REDACTED)
  return sharedRedact(out, { keepIps: true })
}

function loadStored(): LogEntry[] {
  try {
    const raw = sessionStorage.getItem(LOG_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is LogEntry =>
          !!e && typeof e === 'object' && typeof (e as LogEntry).t === 'number' && typeof (e as LogEntry).msg === 'string',
      )
      .map((e): LogEntry => ({ t: e.t, level: e.level === 'warn' || e.level === 'error' ? e.level : 'info', msg: redact(e.msg) }))
      .slice(-LOG_CAPACITY)
  } catch {
    return []
  }
}

/** The close the diagnostics screen explains. */
export interface LastClose {
  code: number
  reason: string
  clean: boolean
  at: number
}

export interface DiagState {
  /** Ring snapshot; replaced (never mutated) on every log() so React re-renders. */
  entries: LogEntry[]
  lastClose: LastClose | null
  /** Consecutive abnormal closes (1006) since the last authOk. */
  abnormalStreak: number
  /** Reconnect attempts scheduled on this page. */
  retries: number
  /** Last measured ping round trip, ms. */
  rttMs: number | null
  /** Pairing path: epoch ms when the 25s ceiling ends (E2-FR-37), null when off. */
  pairCeilingAt: number | null
  /** Pairing path: epoch ms when the current attempt started (PairLog filter). */
  pairStartedAt: number | null
  /** The ceiling ran out before pairPending / paired / pairDenied. */
  pairTimedOut: boolean
  /** DiagnosticsScreen visibility. */
  open: boolean
  update: (p: Partial<DiagState>) => void
}

export const useDiagStore = create<DiagState>((set) => ({
  entries: loadStored(),
  lastClose: null,
  abnormalStreak: 0,
  retries: 0,
  rttMs: null,
  pairCeilingAt: null,
  pairStartedAt: null,
  pairTimedOut: false,
  open: false,
  update: (p) => set(p),
}))

let persistTimer: ReturnType<typeof setTimeout> | undefined

function persist(): void {
  persistTimer = undefined
  try {
    let list = useDiagStore.getState().entries
    let json = JSON.stringify(list)
    while (json.length > LOG_MAX_STORED_CHARS && list.length > 1) {
      list = list.slice(Math.ceil(list.length / 10))
      json = JSON.stringify(list)
    }
    sessionStorage.setItem(LOG_STORAGE_KEY, json)
  } catch {
    /* storage blocked or full: the memory ring still works */
  }
}

/** Append one redacted line; the stored mirror follows within 1s. */
export function log(level: LogLevel, msg: string): void {
  const clean = redact(msg).slice(0, MAX_MSG)
  const prev = useDiagStore.getState().entries
  const next = prev.length >= LOG_CAPACITY ? prev.slice(prev.length - LOG_CAPACITY + 1) : prev.slice()
  next.push({ t: Date.now(), level, msg: clean })
  useDiagStore.getState().update({ entries: next })
  // No storage at all (blocked, or a test without it): nothing to mirror.
  if (!persistTimer && typeof sessionStorage !== 'undefined') persistTimer = setTimeout(persist, LOG_PERSIST_DEBOUNCE_MS)
}

export function entries(): LogEntry[] {
  return useDiagStore.getState().entries
}

/** `12:03:04.512 W close=1006 clean=false dur=1234` */
export function formatEntry(e: LogEntry): string {
  const d = new Date(e.t)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  const lvl = e.level === 'error' ? 'E' : e.level === 'warn' ? 'W' : 'I'
  return `${time} ${lvl} ${e.msg}`
}

export function openDiagnostics(): void {
  useDiagStore.getState().update({ open: true })
}

export function closeDiagnostics(): void {
  useDiagStore.getState().update({ open: false })
}
