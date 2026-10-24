/**
 * B1 ops (app 2.7.0, E10 B1): the team list and header, setup (probe,
 * preview, write, adopt), trust (diff, approve), remove, settings and reveal.
 * Paths arrive only as `setupProbe.dir` / `repoRoot` and are resolved to the
 * git main root here; every other op names a registered team by id.
 */
import { basename, isAbsolute, join } from 'path'
import { canonicalDefText, defaultDraft, definitionIssues, parseDefinition, renderTeamFiles, TEAM_DIR, type TeamSetupDraft } from '@shared/teamDefinition'
import { diffDefinitions } from '@shared/teamDiff'
import type { SetupProbe, SetupWarning, TeamFail, TeamFilePreview, TeamListItem, TrustDiff } from '@shared/team-protocol'
import type { DefError, DefFile } from '@shared/teams'
import type { GitRunner } from '../../git/gitExec'
import { pathKey } from '../../migration/pathUtil'
import { setTeamFlags } from '../flow/agents'
import { TeamDefinitionLoader, type LoadRes } from '../TeamDefinitionLoader'
import { resolveMainRoot } from '../TeamRegistry'
import { sha256Hex } from '../TeamTrust'
import { loadIssues, teamListItem, teamView } from '../views'
import { fail, type OpTable, type TeamInternals } from './types'

/** At most this many local branches in a probe (the base branch select). */
const PROBE_BRANCHES_MAX = 200

function preview(files: readonly DefFile[]): TeamFilePreview[] {
  return files.map((f) => ({ rel: f.rel, text: f.text, bytes: Buffer.byteLength(f.text, 'utf8') }))
}

/** The problems trustDiff, adopt and trust answer with: loadIssues, where a missing folder is also an issue (`missing_team`). */
function opIssues(loaded: LoadRes, repoIssues: readonly DefError[] = []): DefError[] {
  if ('error' in loaded && loaded.error === 'missing') return [{ file: TEAM_DIR, line: 0, code: 'missing_team', severity: 'error' }, ...repoIssues]
  return loadIssues(loaded, repoIssues)
}

export async function currentBranch(git: GitRunner, dir: string): Promise<string | null> {
  try {
    const b = (await git.run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, timeoutMs: 10_000 })).trim()
    return b || null
  } catch {
    return null
  }
}

async function localBranches(git: GitRunner, dir: string): Promise<string[]> {
  try {
    const out = await git.run(['for-each-ref', '--format=%(refname:short)', '--count', String(PROBE_BRANCHES_MAX), 'refs/heads'], { cwd: dir, timeoutMs: 10_000 })
    return out.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** The git main root of a renderer path; `exact`: the path must already be that root (preview, write, adopt). */
async function mainRootOf(svc: TeamInternals, dir: string, exact: boolean): Promise<string | TeamFail> {
  if (!isAbsolute(dir)) return fail('bad_request')
  const root = await resolveMainRoot(svc.git, dir)
  if (root === null) return fail('not_git')
  if (exact && pathKey(root) !== pathKey(dir)) return fail('bad_request', { detail: 'not_main_root' })
  return root
}

function setupWarnings(draft: TeamSetupDraft): SetupWarning[] {
  const roles = draft.roles.filter((r) => r.enabled)
  const out: SetupWarning[] = []
  if (roles.some((r) => r.permission === 'total' && r.provider === 'claude')) out.push('totalBypass')
  if (roles.some((r) => r.permission === 'total' && r.provider === 'codex')) out.push('codexTotal')
  if (roles.some((r) => r.permission === 'readonly' && r.provider === 'codex')) out.push('codexReadonlyBlock')
  if (!draft.verify?.trim()) out.push('noVerify')
  out.push('notCommitted')
  return out
}

function langOf(svc: TeamInternals): 'es' | 'en' {
  return svc.config()?.settings?.language === 'es' ? 'es' : 'en'
}

export const coreOps: Pick<OpTable, 'list' | 'get' | 'setupProbe' | 'setupPreview' | 'setupWrite' | 'adopt' | 'trustDiff' | 'trust' | 'remove' | 'settings' | 'reveal'> = {
  async list(_req, { svc }) {
    const teams: TeamListItem[] = []
    for (const e of svc.registry.list()) {
      await svc.refreshTrust(e.id)
      const rec = svc.team(e.id)
      if (rec) teams.push(teamListItem(rec, svc.shownDef(rec), svc.trusted(e.id)))
    }
    return { ok: true, teams }
  },

  async get(req, { svc }) {
    await svc.refreshTrust(req.teamId)
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    return { ok: true, team: teamView(rec, svc.shownDef(rec), svc.trusted(req.teamId)) }
  },

  async setupProbe(req, { svc }) {
    const root = await mainRootOf(svc, req.dir, false)
    if (typeof root !== 'string') return root
    const lang = langOf(svc)
    const branch = await currentBranch(svc.git, root)
    const defaults = defaultDraft(lang)
    if (branch) defaults.baseBranch = branch
    const probe: SetupProbe = { repoRoot: root, repoName: basename(root), branch, branches: await localBranches(svc.git, root), defaults }
    const teamId = svc.idOf(root)
    if (svc.registry.get(teamId)) probe.registered = teamId
    const loaded = await svc.loader.load(root)
    if (!('error' in loaded)) {
      const repoIssues = loaded.result.ok ? (await svc.resolveRepos(root, loaded.result.def, loaded.files)).issues : []
      probe.existing = {
        sha256: loaded.sha256,
        files: preview(loaded.files),
        issues: loadIssues(loaded, repoIssues),
        diff: diffDefinitions({ files: [], def: null }, { files: loaded.files, def: loaded.result.ok ? loaded.result.def : null }),
      }
    } else if (loaded.error !== 'missing') {
      probe.existing = { sha256: '', files: [], issues: loadIssues(loaded), diff: { files: [], risks: [], truncated: false } }
    }
    return { ok: true, probe }
  },

  async setupPreview(req, { svc }) {
    const root = await mainRootOf(svc, req.repoRoot, true)
    if (typeof root !== 'string') return root
    const files = renderTeamFiles(req.draft)
    const parsed = parseDefinition(files)
    return {
      ok: true,
      preview: {
        files: preview(files),
        hash: sha256Hex(canonicalDefText(files)),
        issues: definitionIssues(parsed),
        warnings: setupWarnings(req.draft),
      },
    }
  },

  async setupWrite(req, { svc }) {
    const root = await mainRootOf(svc, req.repoRoot, true)
    if (typeof root !== 'string') return root
    // Main renders from the draft and hashes: the renderer never computes the hash that counts.
    const files = renderTeamFiles(req.draft)
    const hash = sha256Hex(canonicalDefText(files))
    if (hash !== req.previewHash) return fail('changed')
    const parsed = parseDefinition(files)
    if (!parsed.ok) return fail('invalid_definition', { issues: definitionIssues(parsed) })
    const teamId = svc.idOf(root)
    return svc.serial(teamId, async () => {
      if (svc.registry.get(teamId)) return fail('exists')
      const before = await svc.loader.load(root)
      if (!('error' in before) || before.error !== 'missing') return fail('exists')
      const written = await svc.loader.write(root, files, { overwrite: false })
      if (!written.ok) return written.error === 'exists' ? fail('exists') : fail('io', { detail: written.error })
      const loaded = await svc.loader.load(root)
      if ('error' in loaded) return fail('io', { detail: loaded.error })
      if (loaded.sha256 !== hash || !loaded.result.ok) return fail('changed')
      const branch = req.draft.baseBranch ?? (await currentBranch(svc.git, root)) ?? 'main'
      const added = await svc.addTeam(root, loaded as typeof loaded & { result: { ok: true } }, branch)
      if ('ok' in added) return added
      svc.log(`setup ${added.teamId} written files=${files.length}`)
      return { ok: true, teamId: added.teamId }
    })
  },

  async adopt(req, { svc }) {
    const root = await mainRootOf(svc, req.repoRoot, true)
    if (typeof root !== 'string') return root
    const teamId = svc.idOf(root)
    return svc.serial(teamId, async () => {
      if (svc.registry.get(teamId)) return fail('exists')
      const loaded = await svc.loader.load(root)
      if ('error' in loaded) return loaded.error === 'missing' ? fail('not_found') : fail('invalid_definition', { issues: opIssues(loaded) })
      if (loaded.sha256 !== req.sha256) return fail('changed')
      if (!loaded.result.ok) return fail('invalid_definition', { issues: opIssues(loaded) })
      const branch = loaded.result.def.baseBranch ?? (await currentBranch(svc.git, root)) ?? 'main'
      const added = await svc.addTeam(root, loaded as typeof loaded & { result: { ok: true } }, branch)
      if ('ok' in added) return added
      svc.log(`adopt ${added.teamId}`)
      return { ok: true, teamId: added.teamId }
    })
  },

  async trustDiff(req, { svc }) {
    await svc.refreshTrust(req.teamId)
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const loaded = rec.loaded
    const trusted = svc.trusted(req.teamId)
    const after = 'error' in loaded ? { files: [], def: null } : { files: loaded.files, def: loaded.result.ok ? loaded.result.def : null }
    const trust: TrustDiff = {
      sha256: 'error' in loaded ? '' : loaded.sha256,
      diff: diffDefinitions({ files: trusted?.files ?? [], def: trusted?.def ?? null }, after),
      issues: opIssues(loaded, rec.repoIssues),
    }
    if (trusted) trust.approvedSha = trusted.sha256
    return { ok: true, trust }
  },

  async trust(req, { svc }) {
    return svc.serial(req.teamId, async () => {
      const rec = svc.team(req.teamId)
      if (!rec) return fail('not_found')
      // Re-load: the user approves exactly the sha the dialog showed, never a newer disk.
      const loaded = await svc.loader.load(rec.entry.repoRoot)
      if ('error' in loaded) return fail('invalid_definition', { issues: opIssues(loaded) })
      if (loaded.sha256 !== req.sha256) return fail('changed')
      if (!loaded.result.ok) return fail('invalid_definition', { issues: opIssues(loaded) })
      const failed = await svc.approveTrust(req.teamId, loaded as typeof loaded & { result: { ok: true } })
      if (failed) return failed
      const now = svc.team(req.teamId)
      if (!now) return fail('not_found')
      svc.log(`trust ${req.teamId} approved`)
      return { ok: true, team: teamView(now, svc.shownDef(now), svc.trusted(req.teamId)) }
    })
  },

  async remove(req, { svc }) {
    return svc.serial(req.teamId, async () => {
      const failed = await svc.removeTeam(req.teamId)
      if (failed) return failed
      svc.log(`remove ${req.teamId}`)
      return { ok: true }
    })
  },

  async settings(req, { svc, now }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    svc.commit(req.teamId, setTeamFlags(rec.store.rt, req.patch, { now }), ['team', 'list', 'needs'])
    return { ok: true, team: teamView(rec, svc.shownDef(rec), svc.trusted(req.teamId)) }
  },

  async reveal(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    // Only the two folders main computes: the definition in the repo and the team data folder. Each level the repo
    // controls must be a real directory: the OS opener runs a file and follows a link (a `.app`, a `.command`).
    const repo = rec.entry.repoRoot
    const target = req.what === 'definition' ? TeamDefinitionLoader.dirOf(repo) : join(svc.dataDir(), 'teams', req.teamId)
    const levels = req.what === 'definition' ? [join(repo, '.snagentsos'), target] : [target]
    for (const p of levels) if (!(await svc.loader.isRealDir(p))) return fail('not_found')
    // Electron's shell.openPath: '' when it opened, else its OS error text (kept in detail for
    // diagnostics; the renderer shows only its catalog toast).
    const error = await svc.openPath(target)
    if (error) return fail('io', { detail: error })
    return { ok: true }
  },
}
