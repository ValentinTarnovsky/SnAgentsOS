import { createHash, randomBytes, timingSafeEqual } from 'crypto'

/** Who is calling: the console its token was issued to (E8-FR-13). */
export interface CtlCaller {
  paneId: string
  ptyId: string
  workspaceId: string
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
 */
export class CtlTokens {
  private readonly byDigest = new Map<string, { token: string; caller: CtlCaller }>()
  private readonly byPty = new Map<string, string>()

  constructor(private readonly master: string) {}

  /** A fresh token for this pty (a respawn of the same pty id replaces the old one). */
  issue(ptyId: string, paneId: string, workspaceId: string): string {
    this.revoke(ptyId)
    const token = newToken()
    const key = digest(token)
    this.byDigest.set(key, { token, caller: { paneId, ptyId, workspaceId } })
    this.byPty.set(ptyId, key)
    return token
  }

  revoke(ptyId: string): void {
    const key = this.byPty.get(ptyId)
    if (!key) return
    this.byPty.delete(ptyId)
    this.byDigest.delete(key)
  }

  /** The console behind a token, 'master', or null (unknown, revoked or malformed). */
  resolve(token: unknown): CtlCaller | 'master' | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null
    if (sameToken(token, this.master)) return 'master'
    const hit = this.byDigest.get(digest(token))
    return hit && sameToken(hit.token, token) ? { ...hit.caller } : null
  }

  /** Live console tokens (diagnostics and tests). */
  get size(): number {
    return this.byDigest.size
  }
}
