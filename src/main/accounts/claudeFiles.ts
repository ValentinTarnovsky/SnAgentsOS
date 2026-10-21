import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { writeAtomic } from '../fsAtomic'
import { claudeConfigDir } from '../status/statusDetails'
import type { OauthCred } from '../usage/claude'

/**
 * The live Claude login on disk (app 2.3.0, item 9). Node fs only, no
 * Electron. Rules: errors are reported as codes, never with `err.message`
 * (a JSON.parse message quotes the input) and never with file contents;
 * `.claude.json` is read-only for us; there is no plaintext backup next to
 * the credentials (the previous blob goes encrypted to the vault).
 */

/** `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` (plain text on Windows and Linux). */
export function credentialsPath(): string {
  return join(claudeConfigDir(), '.credentials.json')
}

/** Claude Code's global config: inside CLAUDE_CONFIG_DIR when set (SPIKE 2026-10-20), else `~/.claude.json`. */
export function claudeGlobalConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json')
}

export type LiveCredentials =
  /** A usable login: both tokens present. */
  | { kind: 'ok'; raw: string; cred: OauthCred }
  /** No file. */
  | { kind: 'missing' }
  /** The file parses but holds no tokens (a failed refresh empties it: SPIKE). */
  | { kind: 'empty'; raw: string }
  /** Unreadable or not JSON even after the retries (a write in progress, or a broken file). */
  | { kind: 'bad'; code: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Error code only (`ENOENT`, `EPERM`, ...), never a message. */
export function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'error'
}

/** Parse a credentials blob; null when it is not an object. Never throws, never reports the input. */
export function parseCredentials(raw: string): OauthCred | null {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as OauthCred) : null
  } catch {
    return null
  }
}

/**
 * What a snapshot keeps of a live blob: `claudeAiOauth` only. Claude Code keeps
 * other grants in the same file (`mcpOAuth`, the MCP servers' OAuth tokens,
 * which rotate on their own), and a snapshot must never carry them back.
 */
export function snapshotRaw(cred: OauthCred): string {
  return JSON.stringify({ claudeAiOauth: cred.claudeAiOauth })
}

/**
 * The blob to write for a switch, rollback or re-assert: the live file with
 * only `claudeAiOauth` replaced by the snapshot's, every other key kept as it
 * is on disk (one copy per grant also for the MCP tokens). A missing, empty
 * or broken live file counts as `{}`. Never throws, never reports the input.
 */
export function mergeCredentials(liveRaw: string | null, snapRaw: string): string {
  const live = liveRaw === null ? null : parseCredentials(liveRaw)
  const snap = parseCredentials(snapRaw)
  const base: Record<string, unknown> = live ? { ...(live as Record<string, unknown>) } : {}
  base.claudeAiOauth = snap?.claudeAiOauth
  return JSON.stringify(base)
}

/** Both tokens present. */
export function hasTokens(cred: OauthCred | null): boolean {
  const o = cred?.claudeAiOauth
  return typeof o?.accessToken === 'string' && o.accessToken.length > 0 && typeof o.refreshToken === 'string' && o.refreshToken.length > 0
}

/** Read the live credentials, retrying the parse 3 times 100 ms apart (Claude may be mid-write). */
export async function readCredentials(path: string = credentialsPath()): Promise<LiveCredentials> {
  let code = 'parse'
  for (let i = 0; i < 3; i++) {
    let raw: string
    try {
      raw = await fsp.readFile(path, 'utf8')
    } catch (err) {
      const c = errCode(err)
      if (c === 'ENOENT') return { kind: 'missing' }
      code = c
      if (i < 2) await sleep(100)
      continue
    }
    const cred = parseCredentials(raw)
    if (cred) return hasTokens(cred) ? { kind: 'ok', raw, cred } : { kind: 'empty', raw }
    code = 'parse'
    if (i < 2) await sleep(100)
  }
  return { kind: 'bad', code }
}

/** The identity hint of `.claude.json` (read-only, only these fields are kept). */
export interface OauthAccountLite {
  accountUuid: string
  email: string | null
  organizationUuid: string | null
  organizationName: string | null
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)

/** `oauthAccount` of `.claude.json`: a hint only (it goes stale after a switch, SPIKE). Null on any failure. */
export async function readOauthAccount(path: string = claudeGlobalConfigPath()): Promise<OauthAccountLite | null> {
  try {
    const v = JSON.parse(await fsp.readFile(path, 'utf8')) as { oauthAccount?: Record<string, unknown> } | null
    const a = v?.oauthAccount
    const accountUuid = str(a?.accountUuid, 100)
    if (!a || !accountUuid) return null
    return {
      accountUuid,
      email: str(a.emailAddress),
      organizationUuid: str(a.organizationUuid, 100),
      organizationName: str(a.organizationName),
    }
  } catch {
    return null
  }
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Replace the live credentials atomically (tmp + rename, mode 0o600), retrying
 * 3 times (100/200/400 ms) when Windows holds the file (EPERM/EBUSY/EACCES).
 * Throws an Error whose message is only the code.
 */
export async function writeCredentials(raw: string, path: string = credentialsPath(), deps: { write?: typeof writeAtomic; wait?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const write = deps.write ?? writeAtomic
  const wait = deps.wait ?? sleep
  const delays = [100, 200, 400]
  for (let i = 0; ; i++) {
    try {
      await fsp.mkdir(dirname(path), { recursive: true })
      await write(path, raw, { mode: 0o600 })
      return
    } catch (err) {
      const code = errCode(err)
      if (i < delays.length && RETRY_CODES.has(code)) {
        await wait(delays[i])
        continue
      }
      throw new Error(code)
    }
  }
}

/** Size + mtime of the live file, for the safety poll (null when missing). */
export async function statCredentials(path: string = credentialsPath()): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await fsp.stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}
