// Adaptado de stablyai/orca (MIT) - skills/orca-cli/SKILL.md
// The stub's shape (a discovery stub that loads the versioned guide) follows
// that file; the attribution is in THIRD_PARTY_NOTICES.md.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BRAND } from '@shared/brand'
import { SKILL_OPS, SKILL_TARGETS, type SkillOp, type SkillStatus, type SkillTarget } from '@shared/ctl-protocol'
import { codexHome } from '../agents/codexPaths'

/** Ownership marker on the stub's first body line (E8-FR-21). */
const MARKER_RE = /<!-- managed-by: snagentsos v([^\s>]+) -->/

/**
 * Where an agent looks for skills: <CLAUDE_CONFIG_DIR or ~/.claude>/skills for
 * Claude Code (like HookInstaller.settingsPath()), <CODEX_HOME or ~/.codex>/skills
 * for Codex (like codexHome()). Both read <skills>/<name>/SKILL.md.
 */
function skillsRoot(target: SkillTarget, env: NodeJS.ProcessEnv): string {
  return target === 'codex' ? join(codexHome(env), 'skills') : join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills')
}

/** <skills root of the agent>/snagentsos. */
export function skillDir(target: SkillTarget, env: NodeJS.ProcessEnv = process.env): string {
  return join(skillsRoot(target, env), BRAND.skillDir)
}

/**
 * The generated SKILL.md (never shipped as a file, so it carries the app
 * version). One text for both agents: the front matter is the name +
 * description pair Claude Code and Codex both require (single line, no ": "
 * or " #" so the plain YAML scalar parses), and the body only points at
 * `snaos help --agent`.
 */
export function skillStub(appVersion: string): string {
  return [
    '---',
    `name: ${BRAND.skillDir}`,
    `description: Drive ${BRAND.productName} consoles with the ${BRAND.cliBin} CLI. Use when the user asks to open another console or agent, hand work to Codex or Claude in another console, see what another console is doing or read its chat, read or wait for another console, manage the workspace notes, consoles or workspaces, check the Claude or Codex usage, switch the Claude account, or be notified when something finishes ("otra consola", "pasale esto a codex", "abri un agente nuevo", "avisame cuando termine", "mira que esta haciendo la consola", "lee la consola de codex", "fijate en la otra consola", "anota esto en las notas del workspace", "reinicia esa consola", "cuanto uso me queda", "cambia de cuenta de claude").`,
    '---',
    `<!-- managed-by: ${BRAND.packageName} v${appVersion} -->`,
    `# ${BRAND.productName} CLI`,
    `Resolve the executable once: use %SNAOS_CLI% / $SNAOS_CLI if set, otherwise \`${BRAND.cliBin}\`.`,
    `Before any other command run \`${BRAND.cliBin} help --agent\` and follow that guide; it matches the installed app.`,
    `If a command says ${BRAND.productName} is not running or unreachable, report it and stop.`,
    '',
  ].join('\n')
}

/**
 * The `cli:skill` payload (E8-FR-21): `{ op, target }`, or the old form, a
 * bare op string, which means Claude. The op falls back to 'status' (as it
 * always did) and a target that is present but unknown downgrades the whole
 * request to a read-only 'status' of Claude: nothing is ever written to a
 * folder the caller did not name correctly.
 */
export function parseSkillRequest(raw: unknown): { op: SkillOp; target: SkillTarget } {
  const req = raw !== null && typeof raw === 'object' ? (raw as { op?: unknown; target?: unknown }) : { op: raw, target: undefined }
  const op = (SKILL_OPS as readonly unknown[]).includes(req.op) ? (req.op as SkillOp) : 'status'
  if (req.target === undefined || req.target === null) return { op, target: 'claude' }
  if ((SKILL_TARGETS as readonly unknown[]).includes(req.target)) return { op, target: req.target as SkillTarget }
  return { op: 'status', target: 'claude' }
}

function readMarker(file: string): string | null {
  try {
    const m = readFileSync(file, 'utf8').match(MARKER_RE)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export function skillStatus(target: SkillTarget, appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const dir = skillDir(target, env)
  const file = join(dir, 'SKILL.md')
  if (!existsSync(dir)) return { state: 'missing', target, path: dir }
  const version = readMarker(file)
  if (version === null) return { state: 'foreign', target, path: dir }
  return { state: version === appVersion ? 'installed' : 'outdated', target, version, path: dir }
}

/** Writes the stub (tmp + rename). Refuses to overwrite a folder that is not ours. */
export function installSkill(target: SkillTarget, appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const before = skillStatus(target, appVersion, env)
  if (before.state === 'foreign') return { ...before, error: 'foreign' }
  try {
    mkdirSync(before.path, { recursive: true })
    const file = join(before.path, 'SKILL.md')
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, skillStub(appVersion), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    return { ...skillStatus(target, appVersion, env), error: error instanceof Error ? error.message : 'write failed' }
  }
  return skillStatus(target, appVersion, env)
}

/** Deletes the folder only when the marker is ours; a foreign folder stays untouched. */
export function removeSkill(target: SkillTarget, appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const before = skillStatus(target, appVersion, env)
  if (before.state === 'missing') return before
  if (before.state === 'foreign') return { ...before, error: 'foreign' }
  try {
    rmSync(before.path, { recursive: true, force: true })
  } catch (error) {
    return { ...skillStatus(target, appVersion, env), error: error instanceof Error ? error.message : 'remove failed' }
  }
  return skillStatus(target, appVersion, env)
}

/** "Repair": rewrite our stub (installed or outdated); a missing or foreign one is left as is. */
export function repairSkill(target: SkillTarget, appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const before = skillStatus(target, appVersion, env)
  if (before.state === 'missing' || before.state === 'foreign') return before
  return installSkill(target, appVersion, env)
}

/**
 * Startup refresh (E8-FR-21): an installed stub of another version is
 * rewritten, for Claude and for Codex alike; nothing is ever installed on its
 * own. One status per target, in SKILL_TARGETS order; a failure on one agent's
 * folder never stops the other.
 */
export function refreshSkillOnStartup(appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus[] {
  return SKILL_TARGETS.map((target) => {
    const st = skillStatus(target, appVersion, env)
    return st.state === 'outdated' ? installSkill(target, appVersion, env) : st
  })
}
