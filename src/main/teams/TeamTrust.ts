import { createHash } from 'crypto'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname } from 'path'
import { canonicalDefText, DEF_REL_RE, normalizeDefText, parseDefinition } from '@shared/teamDefinition'
import type { TeamTrustState } from '@shared/team-protocol'
import type { DefFile, TrustedDefinition } from '@shared/teams'
import { writeAtomicSync } from '../fsAtomic'
import type { TrustStore } from '../repoConfig/TrustStore'
import type { LoadedDefinition, LoadRes } from './TeamDefinitionLoader'

const SHA_RE = /^[0-9a-f]{64}$/

/** `teams/<id>/trusted-def.json`. */
interface SnapshotFile {
  v: 1
  sha256: string
  trustedAt: number
  goalHash: string
  files: DefFile[]
}

/**
 * How the trusted snapshot of a team reads: none yet, intact, or failing the integrity check of decision 34.
 * `unreadable` (B close): the snapshot or the TrustStore file exists but cannot be read right now (a lock, a
 * permission): nothing is trusted, nothing is cached (the next read tries again) and no `stateReset` card opens.
 */
export type SnapshotState = 'none' | 'ok' | 'bad' | 'unreadable'

interface Cached {
  repoRoot: string
  state: SnapshotState
  def: TrustedDefinition | null
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The hash a goal is remembered by (`goalSeenHash`, decision 43): of its normalized, trimmed text. */
export function goalHashOf(goal: string): string {
  return sha256Hex(normalizeDefText(goal).trim())
}

/**
 * Trust of a team definition (app 2.7.0, E10 B1, design 3.2): the approved
 * hash lives in a TrustStore (`dataDir()/trusted-teams.json`, keyed by the
 * main root), the approved files in a snapshot next to the team state. Runs
 * read their instructions only from that snapshot, parsed in memory at trust
 * time (decision 34), never from the repo at spawn time. At load the snapshot
 * must re-hash to its own sha256 and match the TrustStore entry, or the team
 * reads `changed` until the user trusts again.
 */
export class TeamTrust {
  private readonly cache = new Map<string, Cached>()

  constructor(
    /** `readable` optional: a store without it always reads (a test fake). */
    private readonly store: Pick<TrustStore, 'get' | 'setChecked' | 'delete'> & Partial<Pick<TrustStore, 'readable'>>,
    private readonly snapshotFile: (teamId: string) => string,
    /** The main root of a registered team, for the TrustStore half of the integrity check. */
    private readonly repoRootOf: (teamId: string) => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * missing | invalid | untrusted | changed | trusted, from a fresh load. With
   * `teamId`, an approval whose snapshot fails the integrity check reads
   * `changed` (the caller opens the `stateReset` card once).
   */
  state(repoRoot: string, loaded: LoadRes, teamId?: string): TeamTrustState {
    if ('error' in loaded) return loaded.error === 'missing' ? 'missing' : 'invalid'
    if (!loaded.result.ok) return 'invalid'
    const entry = this.store.get(repoRoot)
    if (!entry) return 'untrusted'
    if (entry.sha256 !== loaded.sha256) return 'changed'
    if (teamId !== undefined && this.snapshotState(teamId) !== 'ok') return 'changed'
    return 'trusted'
  }

  /**
   * Verify then trust: the caller re-loaded and checked that the sha the user
   * saw equals `loaded.sha256`. Writes the snapshot, then the TrustStore entry;
   * a write that did not land -> `{ error: 'io' }` and the previous snapshot is
   * put back, so nothing reads as trusted that a restart would not.
   */
  approve(teamId: string, repoRoot: string, loaded: LoadedDefinition & { result: { ok: true } }, goalHash: string): TrustedDefinition | { error: 'io' } {
    const file = this.snapshotFile(teamId)
    let previous: string | null = null
    try {
      previous = readFileSync(file, 'utf8')
    } catch (err) {
      // B close: a snapshot that cannot be read right now could not be put back on a failed write: never replaced.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { error: 'io' }
      previous = null
    }
    const trusted: TrustedDefinition = {
      def: loaded.result.def,
      sha256: loaded.sha256,
      goalHash,
      trustedAt: this.now(),
      files: loaded.files.map((f) => ({ rel: f.rel, text: f.text })),
    }
    const body: SnapshotFile = { v: 1, sha256: trusted.sha256, trustedAt: trusted.trustedAt, goalHash, files: trusted.files }
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeAtomicSync(file, JSON.stringify(body) + '\n')
    } catch {
      return { error: 'io' }
    }
    if (!this.store.setChecked(repoRoot, loaded.sha256)) {
      try {
        if (previous === null) rmSync(file, { force: true })
        else writeAtomicSync(file, previous)
      } catch {
        /* the next load reads the mismatch as changed */
      }
      this.cache.delete(teamId)
      return { error: 'io' }
    }
    this.cache.set(teamId, { repoRoot, state: 'ok', def: trusted })
    return trusted
  }

  /** The trusted definition runs read, or null (never trusted, or the snapshot failed its check). */
  trusted(teamId: string): TrustedDefinition | null {
    return this.read(teamId).def
  }

  /** none: no approval and no snapshot; ok; bad: an approval or a snapshot that does not verify; unreadable: read again later. */
  snapshotState(teamId: string): SnapshotState {
    return this.read(teamId).state
  }

  /** Drops the cached snapshot of a team so the next read re-verifies it from disk (enable). */
  reload(teamId: string): void {
    this.cache.delete(teamId)
  }

  /** A removed team: TrustStore.delete of its root and the cache entry (the snapshot leaves with the team folder). */
  forget(repoRoot: string, teamId?: string): void {
    this.store.delete(repoRoot)
    if (teamId) this.cache.delete(teamId)
    for (const [id, c] of this.cache) if (c.repoRoot === repoRoot) this.cache.delete(id)
  }

  private read(teamId: string): Cached {
    const hit = this.cache.get(teamId)
    const repoRoot = this.repoRootOf(teamId)
    if (hit && hit.repoRoot === repoRoot) return hit
    const out: Cached = { repoRoot: repoRoot ?? '', state: 'none', def: null }
    if (repoRoot === null) return out
    // B close: a TrustStore file or a snapshot that cannot be read right now is neither a missing approval nor a
    // tampered snapshot (no 'bad', so no stateReset card): uncached, the next read tries again.
    const unreadable: Cached = { repoRoot, state: 'unreadable', def: null }
    if (this.store.readable?.() === false) return unreadable
    const entry = this.store.get(repoRoot)
    let raw: string | null = null
    try {
      raw = readFileSync(this.snapshotFile(teamId), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return unreadable
      raw = null
    }
    if (raw === null) {
      out.state = entry ? 'bad' : 'none'
      this.cache.set(teamId, out)
      return out
    }
    out.state = 'bad'
    try {
      const s = JSON.parse(raw) as Partial<SnapshotFile>
      const files = Array.isArray(s.files) ? s.files : null
      const shapeOk =
        s.v === 1 && typeof s.sha256 === 'string' && SHA_RE.test(s.sha256) && typeof s.goalHash === 'string' &&
        typeof s.trustedAt === 'number' && files !== null &&
        files.every((f) => f && typeof f.rel === 'string' && DEF_REL_RE.test(f.rel) && typeof f.text === 'string')
      if (shapeOk && entry && entry.sha256 === s.sha256 && sha256Hex(canonicalDefText(files)) === s.sha256) {
        const parsed = parseDefinition(files)
        if (parsed.ok) {
          out.state = 'ok'
          out.def = { def: parsed.def, sha256: s.sha256 as string, goalHash: s.goalHash as string, trustedAt: s.trustedAt as number, files: files.map((f) => ({ rel: f.rel, text: f.text })) }
        }
      }
    } catch {
      /* corrupt: bad */
    }
    this.cache.set(teamId, out)
    return out
  }
}
