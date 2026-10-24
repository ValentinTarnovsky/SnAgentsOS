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
