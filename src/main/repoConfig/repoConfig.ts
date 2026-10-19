import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  REPO_CONFIG_FILE,
  REPO_CONFIG_MAX_BYTES,
  repoConfigNeedsTrust,
  repoCwdProblem,
  type RepoConfigFile,
  type RepoConfigReadRes,
  type RepoConfigWarning,
} from '@shared/repo-config'
import { parseRepoConfig } from './schema'

/** A repo on a slow network drive must not stall the composer (E8-FR-23). */
export const READ_TIMEOUT_MS = 2000
const MAX_DIR_LEN = 4096

/** The trust half of a read (main's TrustStore). */
export interface TrustLookup {
  get(dir: string): { sha256: string } | null
}

/** Minimal fs surface, injectable for tests. */
export interface RepoFs {
  stat(p: string): Promise<{ size: number; isFile(): boolean }>
  readFile(p: string): Promise<Buffer>
  realpath(p: string): Promise<string>
}

const nodeFs: RepoFs = {
  stat: (p) => fsp.stat(p),
  readFile: (p) => fsp.readFile(p),
  realpath: (p) => fsp.realpath(p),
}

/** The text that gets hashed and parsed: UTF-8, no BOM, CRLF (and lone CR) as LF. */
export function normalizeRepoText(buf: Buffer | string): string {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8')
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/** sha256 hex over the normalized text (E8-FR-24): line endings and a BOM never re-ask. */
export function hashContent(buf: Buffer | string): string {
  return createHash('sha256').update(normalizeRepoText(buf), 'utf8').digest('hex')
}

/** Usable repo folder argument: an absolute path without NUL. */
export function validRepoDir(dir: unknown): dir is string {
  return typeof dir === 'string' && dir.length > 0 && dir.length <= MAX_DIR_LEN && !dir.includes('\0') && isAbsolute(dir)
}

/**
 * Lexical check of a console cwd (E8-FR-23): the shared rule, then
 * `path.resolve` + `path.relative` against the repo. Null = inside.
 */
export function validateCwd(repo: string, cwd: string): string | null {
  const lexical = repoCwdProblem(cwd)
  if (lexical) return lexical
  const rel = relative(repo, resolve(repo, cwd))
  if (rel.startsWith('..') || isAbsolute(rel)) return 'escapes the repo'
  return null
}

/** `child` is `parent` or below it (case-insensitive on Windows through path.relative). */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The realpath half (E8-FR-25): repo and target resolved through junctions and
 * symlinks; a target that leaves the repo is an escape. A missing target is
 * not an error: the console starts in the repo folder, with a warning.
 */
export async function realpathCheck(repo: string, cwd: string, fs: RepoFs = nodeFs): Promise<{ ok: true; path: string } | { ok: false; reason: 'escape' | 'missing' }> {
  const target = resolve(repo, cwd)
  let realRepo: string
  try {
    realRepo = await fs.realpath(repo)
  } catch {
    realRepo = resolve(repo)
  }
  let realTarget: string
  try {
    realTarget = await fs.realpath(target)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!inside(realRepo, realTarget)) return { ok: false, reason: 'escape' }
  return { ok: true, path: target }
}

function base(): RepoConfigReadRes {
  return { status: 'none', needsTrust: false, warnings: [] }
}

async function readUnbounded(dir: string, trust: TrustLookup | null, fs: RepoFs): Promise<RepoConfigReadRes> {
  const file = join(dir, REPO_CONFIG_FILE)
  let size: number
  try {
    const st = await fs.stat(file)
    if (!st.isFile()) return base()
    size = st.size
  } catch {
    return base()
  }
  if (size > REPO_CONFIG_MAX_BYTES) {
    return { ...base(), status: 'too_large', errorCode: 'too_large', error: `${REPO_CONFIG_FILE}: ${size} bytes (max ${REPO_CONFIG_MAX_BYTES})` }
  }
  let buf: Buffer
  try {
    buf = await fs.readFile(file)
  } catch (err) {
    return { ...base(), status: 'invalid', errorCode: 'read_failed', error: `${REPO_CONFIG_FILE}: ${(err as Error).message ?? 'read failed'}` }
  }
  // The size may have changed between stat and read.
  if (buf.length > REPO_CONFIG_MAX_BYTES) {
    return { ...base(), status: 'too_large', errorCode: 'too_large', error: `${REPO_CONFIG_FILE}: ${buf.length} bytes (max ${REPO_CONFIG_MAX_BYTES})` }
  }
  const text = normalizeRepoText(buf)
  const sha256 = hashContent(buf)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ...base(), status: 'invalid', sha256, errorCode: 'json', error: `JSON: ${(err as Error).message}` }
  }
  const parsed = parseRepoConfig(raw)
  if (!parsed.ok) return { ...base(), status: 'invalid', sha256, errorCode: 'schema', error: `${parsed.at}: ${parsed.detail}` }
  const config = parsed.config
  const warnings: RepoConfigWarning[] = []
  const consoleCwds: Array<string | null> = []
  for (let i = 0; i < config.consoles.length; i++) {
    const cwd = config.consoles[i].cwd
    if (!cwd) {
      consoleCwds.push(null)
      continue
    }
    const at = `consoles[${i}].cwd`
    const lexical = validateCwd(dir, cwd)
    if (lexical) return { ...base(), status: 'invalid', sha256, errorCode: 'cwd_escape', error: `${at}: ${lexical}` }
    const real = await realpathCheck(dir, cwd, fs)
    if (!real.ok && real.reason === 'escape') {
      return { ...base(), status: 'invalid', sha256, errorCode: 'cwd_escape', error: `${at}: resolves outside the repo (junction or symlink)` }
    }
    if (real.ok) consoleCwds.push(real.path)
    else {
      consoleCwds.push(null)
      warnings.push({ code: 'cwd_missing', at })
    }
  }
  const approved = trust?.get(dir) ?? null
  return {
    status: 'ok',
    config,
    sha256,
    trusted: approved?.sha256 === sha256,
    changedSinceTrust: !!approved && approved.sha256 !== sha256,
    needsTrust: repoConfigNeedsTrust(config),
    warnings,
    consoleCwds,
  }
}

/**
 * `repoConfig:read` (E8-FR-23): at most 64 KB, BOM tolerant, JSON + zod, every
 * console cwd checked lexically and through realpath. A read that takes longer
 * than 2 s (slow network drive) answers `none`.
 */
export async function readRepoConfig(dir: unknown, trust: TrustLookup | null, opts: { fs?: RepoFs; timeoutMs?: number } = {}): Promise<RepoConfigReadRes> {
  if (!validRepoDir(dir)) return base()
  const work = readUnbounded(dir, trust, opts.fs ?? nodeFs).catch(() => base())
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<RepoConfigReadRes>((res) => {
    timer = setTimeout(() => res(base()), opts.timeoutMs ?? READ_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type SerializeRes = { ok: true; json: string; config: RepoConfigFile } | { ok: false; error: string }

/**
 * The exact text an export writes (E8-FR-26): validated against the import
 * schema (so it always reads back), 2 spaces, LF, trailing newline. Every
 * console cwd must pass the same containment rule as an import.
 */
export function serializeRepoConfig(file: unknown): SerializeRes {
  const parsed = parseRepoConfig(file)
  if (!parsed.ok) return { ok: false, error: `${parsed.at}: ${parsed.detail}` }
  for (let i = 0; i < parsed.config.consoles.length; i++) {
    const cwd = parsed.config.consoles[i].cwd
    const problem = cwd ? repoCwdProblem(cwd) : null
    if (problem) return { ok: false, error: `consoles[${i}].cwd: ${problem}` }
  }
  return { ok: true, json: JSON.stringify(parsed.config, null, 2) + '\n', config: parsed.config }
}

/** Atomic write: a temp file next to the target, then rename over it. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.writeFile(tmp, text, 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

/** Whether `<dir>/.snagentsos.json` exists (the dialog then says "Replace"). */
export function repoConfigExists(dir: string): Promise<boolean> {
  return exists(join(dir, REPO_CONFIG_FILE))
}

export type ExportRes = { ok: true; path: string; sha256: string } | { ok: false; error: 'exists' | 'invalid' | 'write_failed'; detail?: string }

/** Write the export (E8-FR-26). Without `overwrite` an existing file is never replaced. */
export async function exportRepoConfig(dir: unknown, file: unknown, overwrite: boolean): Promise<ExportRes> {
  if (!validRepoDir(dir)) return { ok: false, error: 'invalid', detail: 'dir' }
  const ser = serializeRepoConfig(file)
  if (!ser.ok) return { ok: false, error: 'invalid', detail: ser.error }
  const target = join(dir, REPO_CONFIG_FILE)
  if (!overwrite && (await exists(target))) return { ok: false, error: 'exists' }
  try {
    await writeAtomic(target, ser.json)
  } catch (err) {
    return { ok: false, error: 'write_failed', detail: (err as Error).message }
  }
  return { ok: true, path: target, sha256: hashContent(ser.json) }
}
