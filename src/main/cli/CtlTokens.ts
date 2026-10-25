import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { teamPaneId, type RoleKind } from '@shared/teams'

/** App 2.7.0 (Teams): the run a team token was issued to. */
export interface CtlTeamCaller {
  runId: string
  teamId: string
  agentId: string
  roleKind: RoleKind
}

/** Who is calling: the console its token was issued to (E8-FR-13), or a team run (`team`, app 2.7.0). */
export interface CtlCaller {
  paneId: string
  ptyId: string
  workspaceId: string
  /** Set only for a team run's token: paneId and ptyId are then `team:<runId>` and workspaceId is ''. */
  team?: Readonly<CtlTeamCaller>
}

/** 32 random bytes as 64 hex characters. */
export function newToken(): string {
  return randomBytes(32).toString('hex')
}

const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/** The shape newToken gives every token (holdsToken reads a text's hex characters as one run for it). */
const HEX_TOKEN_RE = /^[0-9a-f]{64}$/
/** Hex characters in a row that maskTokens takes for a piece of a live token (no accident at 64 bits). */
const TOKEN_PIECE_MIN = 16
const HEX_RUN_RE = new RegExp(`[0-9a-f]{${TOKEN_PIECE_MIN},}`, 'gi')

/** True when the lowercase hex run `run` is a piece of `token`: inside it, or TOKEN_PIECE_MIN of it at one edge of the run. */
function tokenPiece(run: string, token: string): boolean {
  if (token.includes(run)) return true
  // An edge piece holds the run's TOKEN_PIECE_MIN characters at that edge: neither inside the token, no piece (a git SHA).
  const head = token.includes(run.slice(0, TOKEN_PIECE_MIN))
  const tail = token.includes(run.slice(-TOKEN_PIECE_MIN))
  if (!head && !tail) return false
  for (let k = Math.min(run.length, token.length); k >= TOKEN_PIECE_MIN; k--) {
    if (token.startsWith(run.slice(run.length - k)) || token.endsWith(run.slice(0, k))) return true
  }
  return false
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Console tokens of the CLI (E8-FR-13): one random token per pty, issued by
 * the PtyManager env provider at spawn and revoked when that pty exits. The
 * caller's identity always comes from here, never from a request body.
 *
 * Lookups go through the token's sha256, so the map probe leaks nothing about
 * the token itself, and the stored value is then compared timing-safe. The
 * master token (external terminals) lives outside the map.
 *
 * App 2.7.0 (Teams): a team run gets its own token under the synthetic key
 * `team:<runId>` (as pane and pty id, no workspace), revoked explicitly when
 * the run ends: no pty sink fires for a team process.
 */
export class CtlTokens {
  private readonly byDigest = new Map<string, { token: string; caller: CtlCaller }>()
  private readonly byPty = new Map<string, string>()

  constructor(private readonly master: string) {}

  /** A fresh token for this pty (a respawn of the same pty id replaces the old one). */
  issue(ptyId: string, paneId: string, workspaceId: string): string {
    return this.put({ paneId, ptyId, workspaceId })
  }

  /** A fresh token for a team run (a second issue for the same run replaces the first). */
  issueTeam(runId: string, team: CtlTeamCaller): string {
    const key = teamPaneId(runId)
    // Field by field, and the key's run id: the caller always names the run its key revokes.
    return this.put({ paneId: key, ptyId: key, workspaceId: '', team: { runId, teamId: team.teamId, agentId: team.agentId, roleKind: team.roleKind } })
  }

  revoke(ptyId: string): void {
    const key = this.byPty.get(ptyId)
    if (!key) return
    this.byPty.delete(ptyId)
    this.byDigest.delete(key)
  }

  revokeTeam(runId: string): void {
    this.revoke(teamPaneId(runId))
  }

  /** The console behind a token, 'master', or null (unknown, revoked or malformed). */
  resolve(token: unknown): CtlCaller | 'master' | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null
    if (sameToken(token, this.master)) return 'master'
    const hit = this.byDigest.get(digest(token))
    if (!hit || !sameToken(hit.token, token)) return null
    // A copy all the way down: a handler never mutates the stored caller.
    return { ...hit.caller, ...(hit.caller.team ? { team: { ...hit.caller.team } } : {}) }
  }

  /**
   * B5 integration, fifth round (security): true when `text` holds the master token or a live console or team token,
   * so main refuses a team text that would carry one into the team state (a run could read runtime.json and post it).
   * Every token is 64 hex characters (newToken): besides the text as is, its hex characters are read as one run, in
   * any case, so a token in capitals or cut by spaces, line ends or other characters still counts. Never logs nor
   * returns a token.
   */
  holdsToken(text: string): boolean {
    if (typeof text !== 'string' || text === '') return false
    const lower = text.toLowerCase()
    const hex = lower.replace(/[^0-9a-f]+/g, '')
    const found = (token: string): boolean => {
      if (!token) return false
      const t = token.toLowerCase()
      return lower.includes(t) || (HEX_TOKEN_RE.test(t) && hex.includes(t))
    }
    if (found(this.master)) return true
    for (const { token } of this.byDigest.values()) if (found(token)) return true
    return false
  }

  /**
   * B5 integration, sixth round (security): `text` with every live token (the master and each console or team token)
   * masked, for what main shows of a team run (its chat rows: a run reads runtime.json or a console's env as it
   * likes). Each token as is, in any case, becomes `mask`; a text that still holds one after that (holdsToken: cut by
   * spaces, line ends or other characters) is masked whole. Then every run of TOKEN_PIECE_MIN or more hex characters
   * that is a piece of a live token becomes `mask` too: the decoders cut a text at its cap (CHAT_TOOL_TEXT_MAX, a tail
   * at its start) before main masks it, so a token on the cut leaves up to 63 of its characters, which neither the
   * whole-token pass nor the 64 hex shape of redactCredentials sees. Never logs nor returns a token.
   */
  maskTokens(text: string, mask = '[redacted]'): string {
    if (typeof text !== 'string' || text === '') return text
    const tokens = [this.master, ...[...this.byDigest.values()].map((v) => v.token)].filter((t) => !!t).map((t) => t.toLowerCase())
    let out = text
    let lower = out.toLowerCase()
    for (const token of tokens) {
      if (!lower.includes(token)) continue
      out = out.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), mask)
      lower = out.toLowerCase()
    }
    if (this.holdsToken(out)) return mask
    return out.replace(HEX_RUN_RE, (run) => (tokens.some((t) => tokenPiece(run.toLowerCase(), t)) ? mask : run))
  }

  /** Live console tokens (diagnostics and tests). */
  get size(): number {
    return this.byDigest.size
  }

  private put(caller: CtlCaller): string {
    this.revoke(caller.ptyId)
    const token = newToken()
    const key = digest(token)
    this.byDigest.set(key, { token, caller })
    this.byPty.set(caller.ptyId, key)
    return token
  }
}
