// Adaptado de stablyai/orca (MIT) - skills/orca-cli/SKILL.md
// The stub's shape (a discovery stub that loads the versioned guide) follows
// that file; the attribution is in THIRD_PARTY_NOTICES.md.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BRAND } from '@shared/brand'
import type { SkillStatus } from '@shared/ctl-protocol'

/** Ownership marker on the stub's first body line (E8-FR-21). */
const MARKER_RE = /<!-- managed-by: snagentsos v([^\s>]+) -->/

/** <CLAUDE_CONFIG_DIR or ~/.claude>/skills/snagentsos, like HookInstaller.settingsPath(). */
export function skillDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', BRAND.skillDir)
}

/** The generated SKILL.md (never shipped as a file, so it carries the app version). */
export function skillStub(appVersion: string): string {
  return [
    '---',
    `name: ${BRAND.skillDir}`,
    `description: Drive ${BRAND.productName} consoles with the ${BRAND.cliBin} CLI. Use when the user asks to open another console or agent, hand work to Codex or Claude in another console, read or wait for another console, or be notified when something finishes ("otra consola", "pasale esto a codex", "abri un agente nuevo", "avisame cuando termine").`,
    '---',
    `<!-- managed-by: ${BRAND.packageName} v${appVersion} -->`,
    `# ${BRAND.productName} CLI`,
    `Resolve the executable once: use %SNAOS_CLI% / $SNAOS_CLI if set, otherwise \`${BRAND.cliBin}\`.`,
    `Before any other command run \`${BRAND.cliBin} help --agent\` and follow that guide; it matches the installed app.`,
    `If a command says ${BRAND.productName} is not running or unreachable, report it and stop.`,
    '',
  ].join('\n')
}

function readMarker(file: string): string | null {
  try {
    const m = readFileSync(file, 'utf8').match(MARKER_RE)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export function skillStatus(appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const dir = skillDir(env)
  const file = join(dir, 'SKILL.md')
  if (!existsSync(dir)) return { state: 'missing', path: dir }
  const version = readMarker(file)
  if (version === null) return { state: 'foreign', path: dir }
  return { state: version === appVersion ? 'installed' : 'outdated', version, path: dir }
}

/** Writes the stub (tmp + rename). Refuses to overwrite a folder that is not ours. */
export function installSkill(appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const before = skillStatus(appVersion, env)
  if (before.state === 'foreign') return { ...before, error: 'foreign' }
  try {
    mkdirSync(before.path, { recursive: true })
    const file = join(before.path, 'SKILL.md')
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, skillStub(appVersion), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    return { ...skillStatus(appVersion, env), error: error instanceof Error ? error.message : 'write failed' }
  }
  return skillStatus(appVersion, env)
}

/** Deletes the folder only when the marker is ours; a foreign folder stays untouched. */
export function removeSkill(appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const before = skillStatus(appVersion, env)
  if (before.state === 'missing') return before
  if (before.state === 'foreign') return { ...before, error: 'foreign' }
  try {
    rmSync(before.path, { recursive: true, force: true })
  } catch (error) {
    return { ...skillStatus(appVersion, env), error: error instanceof Error ? error.message : 'remove failed' }
  }
  return skillStatus(appVersion, env)
}

/** "Repair": rewrite our stub (installed or outdated); a missing or foreign one is left as is. */
export function repairSkill(appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const before = skillStatus(appVersion, env)
  if (before.state === 'missing' || before.state === 'foreign') return before
  return installSkill(appVersion, env)
}

/**
 * Startup refresh (E8-FR-21): an installed stub of another version is
 * rewritten; nothing is ever installed on its own. Returns the status.
 */
export function refreshSkillOnStartup(appVersion: string, env: NodeJS.ProcessEnv = process.env): SkillStatus {
  const st = skillStatus(appVersion, env)
  return st.state === 'outdated' ? installSkill(appVersion, env) : st
}
