/**
 * A team's repo definition (app 2.7.0, Tanda B): the files under
 * `.snagentsos/team/` (`team.md`, `roles/<id>.md`, `routines/<id>.md`) to a
 * `TeamDefinition`, and the setup draft back to those files. Pure, no Node or
 * DOM: main parses and hashes, the renderer previews and the tests run it.
 *
 * Grammar (strict, no YAML library): a first line `---`, then `key: value`
 * lines (the value runs to the end of the line, optional surrounding double
 * quotes, full-line `#` comments and blank lines allowed), a closing `---`,
 * then the Markdown body. Unknown and duplicate keys are errors with their
 * line. Text is normalized first (BOM stripped, CRLF and CR to LF) so a CRLF
 * checkout hashes the same and never asks for trust again.
 *
 * Extra repo paths are only syntax-checked here; main resolves them on disk
 * (`TeamService.repoOf`, decision 62). Instructions reach a run only from the
 * trusted snapshot (decision 34).
 */
import type { AgentProvider } from './types'
import type { DefError, DefErrorCode, DefFile, DefSeverity, ExtraRepo, PermissionProfile, RoleDefinition, RoleKind, RoutineDef, TeamDefinition } from './teams'
import {
  GOAL_MAX, GRANTS_MAX, PERMISSION_PROFILES, REPO_ID_RE, REPO_MAIN, RESERVED_ROLE_IDS, ROLE_COUNT_MAX, ROLE_KINDS, RULES_MAX,
  RUN_NOW_PROMPT_MAX, TASK_TITLE_MAX, TEAM_NAME_MAX,
} from './teams'
import { CLAUDE_EFFORTS, isClaudeModel } from './agentTune'
import { cronMinIntervalOk, nextCron, parseCron } from './cron'

export const TEAM_DIR = '.snagentsos/team'
export const DEF_FILES_MAX = 64
export const DEF_FILE_MAX_BYTES = 64 * 1024
export const DEF_TOTAL_MAX_BYTES = 512 * 1024
export const DEF_REL_RE = /^(?:team\.md|roles\/[a-z][a-z0-9-]{0,21}\.md|routines\/[a-z][a-z0-9-]{0,23}\.md)$/
export const EXTRA_REPOS_MAX = 4
export const ROUTINES_MAX = 16
export const ROLES_MAX = 12
export const VERIFY_COMMAND_MAX = 300
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const CODEX_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/
export const TOOL_PATTERN_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\([^()"'`\r\n\u0000-\u001f]{1,120}\))?$/
/** Longest role display name (`name:` of a role file and of a setup draft row). */
export const ROLE_NAME_MAX = 60
/** Longest extra repo path as written. */
export const EXTRA_REPO_PATH_MAX = 1024
/**
 * Two leading separators of either kind: a UNC share or a Windows device path (`\\host\share`, `//host/share`,
 * `\\?\`, `\\.\`, `/\host`). Refused for an extra repo on every platform: touching one on Windows reaches the
 * network (SMB or WebDAV) before any trust.
 */
export const UNC_PATH_RE = /^[\\/]{2}/
/** The routine the setup dialog writes when `dailySummary` is on. */
export const DAILY_SUMMARY_ID = 'daily-summary'
export const DAILY_SUMMARY_CRON = '0 18 * * 1-5'

/** A frontmatter key: letters first, then letters, digits, `_`, `.` and `-` (`repo.<id>.path`). */
const FRONT_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const REPO_KEY_RE = /^repo\.([^.]*)\.([^.]*)$/
const RULES_HEADING_RE = /^##[ \t]+(?:rules|reglas)[ \t]*$/i
const CONTROL_RE = /[\u0000-\u001f\u007f]/
/** `nextCron` looks 4 years ahead from here: a rule that never matches (Feb 30) has no run at all. Fixed so parsing stays pure. */
const CRON_PROBE_FROM = Date.UTC(2026, 0, 1)

/** BOM stripped, CRLF and lone CR to LF. Applied before parse and before hashing. */
export function normalizeDefText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** The exact string main sha256s: files sorted by rel, each `rel + '\0' + normalized text + '\0'`. */
export function canonicalDefText(files: readonly DefFile[]): string {
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return sorted.map((f) => `${f.rel}\0${normalizeDefText(f.text)}\0`).join('')
}

export type FrontmatterRes =
  | { ok: true; fields: Array<{ key: string; value: string; line: number }>; body: string; bodyLine: number }
  | { ok: false; error: DefError }

export function parseFrontmatter(file: string, text: string): FrontmatterRes {
  const lines = normalizeDefText(text).split('\n')
  if (lines[0].trim() !== '---') return { ok: false, error: issue(file, 1, 'error', 'frontmatter', undefined, 'open') }
  const fields: Array<{ key: string; value: string; line: number }> = []
  const seen = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---') return { ok: true, fields, body: lines.slice(i + 1).join('\n'), bodyLine: i + 2 }
    if (line === '' || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    const key = colon > 0 ? line.slice(0, colon).trim() : ''
    if (!FRONT_KEY_RE.test(key)) return { ok: false, error: issue(file, i + 1, 'error', 'frontmatter', undefined, 'line') }
    if (seen.has(key)) return { ok: false, error: issue(file, i + 1, 'error', 'duplicate_key', key) }
    seen.add(key)
    let value = line.slice(colon + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    fields.push({ key, value, line: i + 1 })
  }
  return { ok: false, error: issue(file, lines.length, 'error', 'frontmatter', undefined, 'close') }
}

/** Warnings come on both sides: a failing folder still shows its stray files. */
export type DefinitionResult = { ok: true; def: TeamDefinition; warnings: DefError[] } | { ok: false; errors: DefError[]; warnings: DefError[] }

/** Every issue of a parse, errors first: what the screens list (each one carries its severity). */
export function definitionIssues(r: DefinitionResult): DefError[] {
  return r.ok ? [...r.warnings] : [...r.errors, ...r.warnings]
}

/** A name starting with "." (`._dev.md`, an editor temp file) is not part of the definition, not even as a warning. */
export function ignoredDefName(name: string): boolean {
  return name.startsWith('.')
}

export function validToolPattern(p: string): boolean {
  return typeof p === 'string' && TOOL_PATTERN_RE.test(p)
}

/** Git branch name syntax (the `check-ref-format --branch` rules that matter here), <= 200 chars. */
export function validBranchName(b: string): boolean {
  if (typeof b !== 'string' || b.length === 0 || b.length > 200) return false
  if (/[\u0000- \u007f~^:?*[\\]/.test(b)) return false
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false
  if (b.includes('..') || b.includes('//') || b.includes('@{') || b === '@') return false
  return !b.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
}

/** UTF-8 byte length without Buffer or TextEncoder (src/shared stays DOM and Node free). */
function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

function intIn(value: string, min: number, max: number): number | null {
  if (!/^[0-9]{1,4}$/.test(value)) return null
  const n = Number(value)
  return n >= min && n <= max ? n : null
}

function boolOf(value: string): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null
}

/** Splits a comma list at paren depth 0, so `Bash(a,b)` stays one item. */
function splitTools(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out.filter((t) => t !== '')
}

type Fields = Map<string, { value: string; line: number }>

class Issues {
  errors: DefError[] = []
  warnings: DefError[] = []
  err(file: string, line: number, code: DefErrorCode, key?: string, detail?: string): void {
    this.errors.push(issue(file, line, 'error', code, key, detail))
  }
  warn(file: string, line: number, code: DefErrorCode, key?: string, detail?: string): void {
    this.warnings.push(issue(file, line, 'warning', code, key, detail))
  }
}

/** Fields in DefError order, absent ones left out (stable JSON). */
function issue(file: string, line: number, severity: DefSeverity, code: DefErrorCode, key?: string, detail?: string): DefError {
  return { file, line, ...(key !== undefined ? { key } : {}), code, ...(detail !== undefined ? { detail } : {}), severity }
}

/** A one-line text field: trimmed, no control chars, within max; '' stays '' (the caller decides if it is required). */
function lineText(f: string, field: { value: string; line: number }, key: string, max: number, is: Issues): string | null {
  const v = field.value.trim()
  if (CONTROL_RE.test(v)) {
    is.err(f, field.line, 'bad_value', key)
    return null
  }
  if (v.length > max) {
    is.err(f, field.line, 'too_large', key, String(max))
    return null
  }
  return v
}

interface TeamPart { name: string; goal: string; rules: string; baseBranch?: string; verify?: string; verifyTimeoutMin: number; maxRunMinutes: number; maxConcurrent: number; leadApprovesSmallPlans: boolean; extraRepos: ExtraRepo[] }

function parseTeam(file: DefFile, is: Issues): TeamPart | null {
  const f = file.rel
  const fm = parseFrontmatter(f, file.text)
  if (!fm.ok) {
    is.errors.push(fm.error)
    return null
  }
  const before = is.errors.length
  const out: TeamPart = { name: '', goal: '', rules: '', verifyTimeoutMin: 20, maxRunMinutes: 45, maxConcurrent: 2, leadApprovesSmallPlans: true, extraRepos: [] }
  // `refused`: a path was written but failed its check (its own error says why; no "required" on top).
  const repos = new Map<string, { line: number; path?: string; refused?: boolean; baseBranch?: string; verify?: string }>()
  let nameSeen = false
  for (const field of fm.fields) {
    const { key, value, line } = field
    const repoKey = REPO_KEY_RE.exec(key)
    if (repoKey) {
      const [, id, prop] = repoKey
      if (prop !== 'path' && prop !== 'baseBranch' && prop !== 'verify') {
        is.err(f, line, 'unknown_key', key)
        continue
      }
      if (!REPO_ID_RE.test(id) || id === REPO_MAIN) {
        is.err(f, line, 'bad_name', key, id)
        continue
      }
      const repo = repos.get(id) ?? { line }
      repos.set(id, repo)
      if (value === '') continue
      if (prop === 'path') {
        if (CONTROL_RE.test(value)) is.err(f, line, 'bad_value', key)
        else if (value.length > EXTRA_REPO_PATH_MAX) is.err(f, line, 'too_large', key, String(EXTRA_REPO_PATH_MAX))
        // Lexical, before anything touches the disk: main never resolves a share or a device path.
        else if (UNC_PATH_RE.test(value)) is.err(f, line, 'repo', key, 'unc')
        else repo.path = value
        if (repo.path === undefined) repo.refused = true
      } else if (prop === 'baseBranch') {
        if (validBranchName(value)) repo.baseBranch = value
        else is.err(f, line, 'bad_value', key)
      } else {
        const v = lineText(f, field, key, VERIFY_COMMAND_MAX, is)
        if (v) repo.verify = v
      }
      continue
    }
    switch (key) {
      case 'name': {
        nameSeen = true
        const v = lineText(f, field, key, TEAM_NAME_MAX, is)
        if (v === '') is.err(f, line, 'required', key)
        else if (v) out.name = v
        break
      }
      case 'baseBranch':
        if (value === '') break
        if (validBranchName(value)) out.baseBranch = value
        else is.err(f, line, 'bad_value', key)
        break
      case 'verify': {
        const v = lineText(f, field, key, VERIFY_COMMAND_MAX, is)
        if (v) out.verify = v
        break
      }
      case 'verifyTimeoutMin':
      case 'maxRunMinutes':
      case 'maxConcurrent': {
        if (value === '') break
        const [min, max] = key === 'verifyTimeoutMin' ? [5, 60] : key === 'maxRunMinutes' ? [5, 120] : [1, 3]
        const n = intIn(value, min, max)
        if (n === null) is.err(f, line, 'bad_value', key, `${min}..${max}`)
        else out[key as 'verifyTimeoutMin' | 'maxRunMinutes' | 'maxConcurrent'] = n
        break
      }
      case 'leadApprovesSmallPlans': {
        if (value === '') break
        const b = boolOf(value)
        if (b === null) is.err(f, line, 'bad_value', key, 'true|false')
        else out.leadApprovesSmallPlans = b
        break
      }
      default:
        is.err(f, line, 'unknown_key', key)
    }
  }
  if (!nameSeen) is.err(f, 1, 'required', 'name')
  let n = 0
  for (const [id, repo] of repos) {
    n++
    if (n > EXTRA_REPOS_MAX) {
      is.err(f, repo.line, 'too_many', `repo.${id}.path`, String(EXTRA_REPOS_MAX))
      continue
    }
    if (repo.path === undefined) {
      if (!repo.refused) is.err(f, repo.line, 'required', `repo.${id}.path`)
      continue
    }
    const extra: ExtraRepo = { id, path: repo.path }
    if (repo.baseBranch !== undefined) extra.baseBranch = repo.baseBranch
    if (repo.verify !== undefined) extra.verify = repo.verify
    out.extraRepos.push(extra)
  }
  const bodyLines = fm.body.split('\n')
  const heading = bodyLines.findIndex((l) => RULES_HEADING_RE.test(l.trim()))
  out.goal = (heading < 0 ? bodyLines : bodyLines.slice(0, heading)).join('\n').trim()
  out.rules = heading < 0 ? '' : bodyLines.slice(heading + 1).join('\n').trim()
  if (out.goal.length > GOAL_MAX) is.err(f, fm.bodyLine, 'too_large', 'goal', String(GOAL_MAX))
  if (out.rules.length > RULES_MAX) is.err(f, fm.bodyLine + heading, 'too_large', 'rules', String(RULES_MAX))
  return is.errors.length === before ? out : null
}

const ROLE_KEYS = ['name', 'kind', 'provider', 'model', 'effort', 'permission', 'allowedTools', 'count']

function fieldsOf(f: string, fm: { fields: Array<{ key: string; value: string; line: number }> }, known: readonly string[], is: Issues): Fields {
  const map: Fields = new Map()
  for (const field of fm.fields) {
    if (known.includes(field.key)) map.set(field.key, { value: field.value, line: field.line })
    else is.err(f, field.line, 'unknown_key', field.key)
  }
  return map
}

/** The value of a required key, or null after reporting it missing or empty. */
function required(f: string, fields: Fields, key: string, is: Issues): { value: string; line: number } | null {
  const field = fields.get(key)
  if (!field || field.value.trim() === '') {
    is.err(f, field?.line ?? 1, 'required', key)
    return null
  }
  return field
}

/** A role file as far as it could be read: the folder-level rules (one lead, routine roles) use `kind` even when the role failed. */
interface RoleParse { id: string; kind: RoleKind | null; role: RoleDefinition | null }

function parseRole(file: DefFile, id: string, is: Issues): RoleParse {
  const f = file.rel
  const fm = parseFrontmatter(f, file.text)
  if (!fm.ok) {
    is.errors.push(fm.error)
    return { id, kind: null, role: null }
  }
  const before = is.errors.length
  const fields = fieldsOf(f, fm, ROLE_KEYS, is)
  if (RESERVED_ROLE_IDS.includes(id)) is.err(f, 0, 'reserved_name', undefined, id)
  const nameField = required(f, fields, 'name', is)
  const name = nameField ? lineText(f, nameField, 'name', ROLE_NAME_MAX, is) : null
  const kindField = required(f, fields, 'kind', is)
  const kind = kindField && (ROLE_KINDS as readonly string[]).includes(kindField.value) ? (kindField.value as RoleKind) : null
  if (kindField && !kind) is.err(f, kindField.line, 'bad_value', 'kind', ROLE_KINDS.join('|'))
  const providerField = required(f, fields, 'provider', is)
  const provider = providerField && (providerField.value === 'claude' || providerField.value === 'codex') ? (providerField.value as AgentProvider) : null
  if (providerField && !provider) is.err(f, providerField.line, 'bad_value', 'provider', 'claude|codex')
  const permField = required(f, fields, 'permission', is)
  const permission = permField && (PERMISSION_PROFILES as readonly string[]).includes(permField.value) ? (permField.value as PermissionProfile) : null
  if (permField && !permission) is.err(f, permField.line, 'bad_value', 'permission', PERMISSION_PROFILES.join('|'))

  let model: string | undefined
  const modelField = fields.get('model')
  if (modelField && modelField.value !== '' && modelField.value !== 'default' && provider) {
    const ok = provider === 'claude' ? isClaudeModel(modelField.value) : CODEX_MODEL_RE.test(modelField.value)
    if (ok) model = modelField.value
    else is.err(f, modelField.line, 'bad_model', 'model', modelField.value.slice(0, 64))
  }
  let effort: string | undefined
  const effortField = fields.get('effort')
  if (effortField && effortField.value !== '' && provider) {
    const allowed: readonly string[] = provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS
    if (allowed.includes(effortField.value)) effort = effortField.value
    else is.err(f, effortField.line, 'bad_effort', 'effort', allowed.join('|'))
  }
  let allowedTools: string[] | undefined
  const toolsField = fields.get('allowedTools')
  if (toolsField && toolsField.value !== '') {
    const tools = splitTools(toolsField.value)
    if (permission && permission !== 'custom') is.err(f, toolsField.line, 'bad_value', 'allowedTools', 'custom')
    else if (tools.length > GRANTS_MAX) is.err(f, toolsField.line, 'too_many', 'allowedTools', String(GRANTS_MAX))
    else {
      const bad = tools.find((t) => !validToolPattern(t))
      if (bad !== undefined) is.err(f, toolsField.line, 'tool_pattern', 'allowedTools', bad.slice(0, 120))
      else {
        allowedTools = [...new Set(tools)]
        if (provider === 'codex') is.warn(f, toolsField.line, 'bad_value', 'allowedTools', 'codex')
      }
    }
  }
  let count = 1
  const countField = fields.get('count')
  if (countField && countField.value !== '') {
    const n = intIn(countField.value, 1, ROLE_COUNT_MAX)
    if (n === null) is.err(f, countField.line, 'bad_value', 'count', `1..${ROLE_COUNT_MAX}`)
    else count = n
  }
  if (kind === 'lead' && count !== 1) is.err(f, countField?.line ?? 1, 'lead_count', 'count')
  if (is.errors.length !== before || !name || !kind || !provider || !permission) return { id, kind, role: null }
  // Keys in RoleDefinition order, absent ones left out: the snapshot JSON stays stable.
  const role: RoleDefinition = {
    id, name, kind, provider,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    permission,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    count,
    instructions: fm.body.trim(),
  }
  return { id, kind, role }
}

const ROUTINE_KEYS = ['cron', 'action', 'role', 'title', 'enabled']

function parseRoutine(file: DefFile, id: string, roles: readonly RoleParse[], is: Issues): RoutineDef | null {
  const f = file.rel
  const fm = parseFrontmatter(f, file.text)
  if (!fm.ok) {
    is.errors.push(fm.error)
    return null
  }
  const before = is.errors.length
  const fields = fieldsOf(f, fm, ROUTINE_KEYS, is)
  let cron: string | null = null
  const cronField = required(f, fields, 'cron', is)
  if (cronField) {
    const spec = parseCron(cronField.value)
    if (!spec || nextCron(spec, CRON_PROBE_FROM) === null) is.err(f, cronField.line, 'cron', 'cron')
    else if (!cronMinIntervalOk(spec)) is.err(f, cronField.line, 'cron_interval', 'cron')
    else cron = spec.expr
  }
  let action: 'wake' | 'task' = 'wake'
  const actionField = fields.get('action')
  if (actionField && actionField.value !== '') {
    if (actionField.value === 'wake' || actionField.value === 'task') action = actionField.value
    else is.err(f, actionField.line, 'bad_value', 'action', 'wake|task')
  }
  const roleField = required(f, fields, 'role', is)
  if (roleField) {
    const role = roles.find((r) => r.id === roleField.value)
    if (!role) is.err(f, roleField.line, 'routine_role', 'role', roleField.value.slice(0, 64))
    else if (action === 'task' && role.kind === 'lead') is.err(f, roleField.line, 'routine_role', 'role', 'lead')
  }
  let title: string | undefined
  const titleField = fields.get('title')
  if (titleField) {
    const v = lineText(f, titleField, 'title', TASK_TITLE_MAX, is)
    if (v) title = v
  }
  let enabled = true
  const enabledField = fields.get('enabled')
  if (enabledField && enabledField.value !== '') {
    const b = boolOf(enabledField.value)
    if (b === null) is.err(f, enabledField.line, 'bad_value', 'enabled', 'true|false')
    else enabled = b
  }
  const prompt = fm.body.trim()
  if (prompt === '') is.err(f, fm.bodyLine, 'required', 'prompt')
  else if (prompt.length > RUN_NOW_PROMPT_MAX) is.err(f, fm.bodyLine, 'too_large', 'prompt', String(RUN_NOW_PROMPT_MAX))
  if (is.errors.length !== before || !cron || !roleField) return null
  return { id, cron, action, role: roleField.value, ...(title !== undefined ? { title } : {}), prompt, enabled }
}

/**
 * Whole folder -> definition. Exactly one role of kind lead with count 1; no RESERVED_ROLE_IDS; every routine names
 * an existing role; cron passes parseCron, nextCron !== null and cronMinIntervalOk; models and efforts from the
 * allowlists (isClaudeModel / CLAUDE_EFFORTS of agentTune.ts, CODEX_MODEL_RE / CODEX_EFFORTS); allowedTools only on
 * custom roles and each TOOL_PATTERN_RE; extra repo paths are only syntax-checked here (one line, <= 1024 chars, no `\0`,
 * relative with `/` or `\` separators or absolute, never UNC_PATH_RE); main resolves them on disk with
 * `TeamService.repoOf` (3.2, decision 62).
 *
 * Also refused: a role id that another role's agents would use (`dev-2` next to `dev`, decision 20), and a `task`
 * routine for the lead (a task is never assigned to the lead). A file outside DEF_REL_RE is never part of the
 * definition and only warns (`bad_name`, also a misnamed `roles/Dev.md`): it is shown, never blocks a trust or a run.
 * A file whose name starts with "." is ignored (ignoredDefName).
 */
export function parseDefinition(all: readonly DefFile[]): DefinitionResult {
  const is = new Issues()
  const files = all.filter((f) => !ignoredDefName(f.rel.slice(f.rel.lastIndexOf('/') + 1)))
  if (files.length > DEF_FILES_MAX) is.err(TEAM_DIR, 0, 'too_many', undefined, String(DEF_FILES_MAX))
  let total = 0
  for (const file of files) {
    const bytes = utf8Bytes(normalizeDefText(file.text))
    total += bytes
    if (bytes > DEF_FILE_MAX_BYTES) is.err(file.rel, 0, 'too_large', undefined, String(DEF_FILE_MAX_BYTES))
  }
  if (total > DEF_TOTAL_MAX_BYTES) is.err(TEAM_DIR, 0, 'too_large', undefined, String(DEF_TOTAL_MAX_BYTES))

  let teamFile: DefFile | undefined
  const roleFiles: DefFile[] = []
  const routineFiles: DefFile[] = []
  const rels = new Set<string>()
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const file of sorted) {
    if (rels.has(file.rel)) {
      is.err(file.rel, 0, 'bad_name', undefined, 'duplicate')
      continue
    }
    rels.add(file.rel)
    if (!DEF_REL_RE.test(file.rel)) {
      is.warn(file.rel, 0, 'bad_name')
      continue
    }
    if (file.rel === 'team.md') teamFile = file
    else if (file.rel.startsWith('roles/')) roleFiles.push(file)
    else routineFiles.push(file)
  }

  const team = teamFile ? parseTeam(teamFile, is) : null
  if (!teamFile) is.err('team.md', 0, 'missing_team')

  if (roleFiles.length > ROLES_MAX) is.err('roles', 0, 'too_many', undefined, String(ROLES_MAX))
  // Every role file counts for the folder rules, also one that failed: a lead with a bad model is not "no lead".
  const parsed = roleFiles.map((file) => parseRole(file, file.rel.slice('roles/'.length, -'.md'.length), is))
  const roles = parsed.flatMap((p) => (p.role ? [p.role] : []))
  const ids = new Set(parsed.map((p) => p.id))
  for (const p of parsed) {
    const m = /^(.+)-([2-9])$/.exec(p.id)
    if (m && ids.has(m[1]) && Number(m[2]) <= ROLE_COUNT_MAX) is.err(`roles/${p.id}.md`, 0, 'bad_name', undefined, m[1])
  }
  const leads = parsed.filter((p) => p.kind === 'lead')
  // A role whose kind could not be read may be the lead: its own error says so.
  if (leads.length === 0 && parsed.every((p) => p.kind !== null)) is.err('roles', 0, 'no_lead')
  for (const extra of leads.slice(1)) is.err(`roles/${extra.id}.md`, 0, 'two_leads')

  if (routineFiles.length > ROUTINES_MAX) is.err('routines', 0, 'too_many', undefined, String(ROUTINES_MAX))
  const routines: RoutineDef[] = []
  for (const file of routineFiles) {
    const routine = parseRoutine(file, file.rel.slice('routines/'.length, -'.md'.length), parsed, is)
    if (routine) routines.push(routine)
  }

  if (is.errors.length > 0 || !team) return { ok: false, errors: is.errors, warnings: is.warnings }
  const def: TeamDefinition = {
    name: team.name,
    goal: team.goal,
    rules: team.rules,
    ...(team.baseBranch !== undefined ? { baseBranch: team.baseBranch } : {}),
    ...(team.verify !== undefined ? { verify: team.verify } : {}),
    verifyTimeoutMin: team.verifyTimeoutMin,
    maxRunMinutes: team.maxRunMinutes,
    maxConcurrent: team.maxConcurrent,
    leadApprovesSmallPlans: team.leadApprovesSmallPlans,
    extraRepos: team.extraRepos,
    routines,
    roles,
  }
  return { ok: true, def, warnings: is.warnings }
}

// ---- setup draft ----------------------------------------------------------------------------------

/** Setup dialog draft (the renderer edits this, never file text). */
export interface RoleDraft {
  id: string; name: string; kind: RoleKind; provider: AgentProvider; model?: string; effort?: string
  permission: 'total' | 'readonly'; count: number; enabled: boolean
}
export interface TeamSetupDraft {
  lang: 'es' | 'en'; name: string; goal: string; rules?: string; baseBranch?: string
  maxConcurrent: 1 | 2 | 3; leadApprovesSmallPlans: boolean; verify?: string; roles: RoleDraft[]
  dailySummary: boolean                            // writes routines/daily-summary.md (0 18 * * 1-5, Lead note)
}

type Lang = 'es' | 'en'

const TEMPLATE = {
  es: {
    team: 'Equipo',
    roles: { lead: 'Líder', dev: 'Dev', qa: 'QA', research: 'Investigación' },
    rules: [
      '- Trabajá en pasos chicos y verificables.',
      '- No hagas push ni merge y no toques otras ramas: integrar lo hace el usuario desde la app.',
      '- Si te falta información, preguntá con `snaos team ask` en vez de adivinar.',
    ].join('\n'),
    summaryTitle: 'Resumen diario',
    summaryPrompt: 'Escribí el resumen del día con `snaos team note --title "Resumen diario"`: qué se terminó, qué sigue en curso, qué está bloqueado y qué necesita al usuario. Sé breve.',
    instructions: {
      lead: [
        'Sos el Líder del equipo. Convertís la meta en tareas chicas y concretas y seguís el avance del tablero. No escribís código.',
        '',
        '- Creá cada tarea con `snaos team task create`: un título claro, el detalle en el cuerpo (`--body-file -`) y `--blocked-by` cuando depende de otra.',
        '- Asigná el desarrollo a los Devs con `--assign`. Las tareas de investigación van con `--no-plan` y asignadas al rol de investigación.',
        '- Aprobá con `snaos team approve --plan <tarea>` solo los planes chicos que leíste completos; el resto lo decide el usuario.',
        '- Cuando el usuario te escriba, respondé corto y actualizá el tablero si hace falta.',
        '- Para el resumen diario escribí una nota con `snaos team note`: qué se terminó, qué sigue en curso, qué está bloqueado y qué necesita al usuario.',
      ].join('\n'),
      dev: [
        'Sos un Dev del equipo. Implementás las tareas que te asignan.',
        '',
        '- Si la tarea pide plan, leé el código y mandá un plan concreto (archivos, pasos y cómo lo vas a probar) con `snaos team plan --file -`. Si el cambio es chico, sumá `--small`.',
        '- Con el plan aprobado, hacé el cambio, corré las pruebas que correspondan y hacé commit en tu rama.',
        '- Al terminar, pedí la revisión con `snaos team review` y un resumen corto de lo que cambiaste.',
        '- Si algo no está claro o te falta un dato, preguntá con `snaos team ask` en vez de adivinar.',
      ].join('\n'),
      qa: [
        'Sos el QA del equipo. Revisás el trabajo de los Devs sin modificar archivos.',
        '',
        '- Leé la tarea y el plan aprobado. Leé los cambios de la rama contra su base con `snaos team diff` (`--stat` primero) y su historia con `snaos team log`.',
        '- Corré las pruebas y las verificaciones que no escriban archivos de a un comando por vez (por ejemplo `npm test`), nunca encadenados con `&&`, `;` o `|`: tu perfil es de solo lectura y un comando compuesto se niega.',
        '- Si te niegan un comando, no lo intentes de otra forma: la negación queda como un pedido de permiso para el usuario.',
        '- Si está bien, aprobá con `snaos team verdict approve` y un resumen. Si hay que corregir algo, usá `snaos team verdict changes` con una lista concreta de lo que falta.',
      ].join('\n'),
      research: [
        'Sos el rol de investigación del equipo. Respondés preguntas sobre el código, las dependencias o el enfoque, sin modificar archivos.',
        '',
        '- Leé lo necesario y escribí conclusiones concretas, con referencias a archivos y líneas.',
        '- Cerrá la tarea con `snaos team done` y tu informe. Si la tarea pide plan, mandalo con `snaos team plan --file -`.',
      ].join('\n'),
      custom: 'Seguí las reglas del equipo y las instrucciones de cada tarea. Cerrá cada corrida con una herramienta del equipo: `snaos team done`, `snaos team ask` o `snaos team needs`.',
    },
  },
  en: {
    team: 'Team',
    roles: { lead: 'Lead', dev: 'Dev', qa: 'QA', research: 'Research' },
    rules: [
      '- Work in small, verifiable steps.',
      '- Never push or merge and never touch other branches: the user integrates from the app.',
      '- If information is missing, ask with `snaos team ask` instead of guessing.',
    ].join('\n'),
    summaryTitle: 'Daily summary',
    summaryPrompt: 'Write today\'s summary with `snaos team note --title "Daily summary"`: what was finished, what is in progress, what is blocked and what needs the user. Keep it short.',
    instructions: {
      lead: [
        'You are the team Lead. You turn the goal into small, concrete tasks and follow the board. You do not write code.',
        '',
        '- Create each task with `snaos team task create`: a clear title, the details in the body (`--body-file -`) and `--blocked-by` when it depends on another one.',
        '- Assign development to the Devs with `--assign`. Research tasks go with `--no-plan`, assigned to the research role.',
        '- Approve with `snaos team approve --plan <task>` only the small plans you read in full; the user decides the rest.',
        '- When the user writes to you, answer briefly and update the board when needed.',
        '- For the daily summary write a note with `snaos team note`: what was finished, what is in progress, what is blocked and what needs the user.',
      ].join('\n'),
      dev: [
        'You are a Dev of the team. You implement the tasks assigned to you.',
        '',
        '- When the task needs a plan, read the code and send a concrete plan (files, steps and how you will test it) with `snaos team plan --file -`. Add `--small` for a small change.',
        '- Once the plan is approved, make the change, run the relevant tests and commit on your branch.',
        '- When you are done, ask for review with `snaos team review` and a short summary of what you changed.',
        '- If something is unclear or missing, ask with `snaos team ask` instead of guessing.',
      ].join('\n'),
      qa: [
        'You are the team QA. You review the Devs\' work without changing files.',
        '',
        '- Read the task and the approved plan. Read the branch changes against its base with `snaos team diff` (`--stat` first) and its history with `snaos team log`.',
        '- Run the tests and checks that do not write files one command at a time (for example `npm test`), never chained with `&&`, `;` or `|`: your profile is read-only and a compound command is denied.',
        '- When a command is denied, do not try it another way: the denial becomes a permission request for the user.',
        '- When it is good, approve with `snaos team verdict approve` and a summary. When something must change, use `snaos team verdict changes` with a concrete list of what is missing.',
      ].join('\n'),
      research: [
        'You are the research role of the team. You answer questions about the code, the dependencies or the approach, without changing files.',
        '',
        '- Read what you need and write concrete conclusions, with references to files and lines.',
        '- Close the task with `snaos team done` and your report. When the task needs a plan, send it with `snaos team plan --file -`.',
      ].join('\n'),
      custom: 'Follow the team rules and each task\'s instructions. End every run with a team tool: `snaos team done`, `snaos team ask` or `snaos team needs`.',
    },
  },
} as const

/** Plan 3.2 template: lead opus high readonly; dev sonnet medium total x2; qa sonnet readonly; research sonnet readonly. */
export function defaultDraft(lang: 'es' | 'en'): TeamSetupDraft {
  const t = TEMPLATE[lang]
  return {
    lang,
    name: t.team,
    goal: '',
    rules: t.rules,
    maxConcurrent: 2,
    leadApprovesSmallPlans: true,
    roles: [
      { id: 'lead', name: t.roles.lead, kind: 'lead', provider: 'claude', model: 'opus', effort: 'high', permission: 'readonly', count: 1, enabled: true },
      { id: 'dev', name: t.roles.dev, kind: 'dev', provider: 'claude', model: 'sonnet', effort: 'medium', permission: 'total', count: 2, enabled: true },
      { id: 'qa', name: t.roles.qa, kind: 'qa', provider: 'claude', model: 'sonnet', permission: 'readonly', count: 1, enabled: true },
      { id: 'research', name: t.roles.research, kind: 'research', provider: 'claude', model: 'sonnet', permission: 'readonly', count: 1, enabled: true },
    ],
    dailySummary: true,
  }
}

/** One frontmatter line value: control chars to spaces, trimmed. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

/** Quoted only when parsing would otherwise change it (empty, or already wrapped in double quotes). */
function frontValue(v: string): string {
  return v === '' || (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) ? `"${v}"` : v
}

function fileText(fields: ReadonlyArray<readonly [string, string | number | boolean | undefined]>, body: string): string {
  const lines = ['---']
  for (const [key, value] of fields) if (value !== undefined) lines.push(`${key}: ${typeof value === 'string' ? frontValue(oneLine(value)) : String(value)}`)
  lines.push('---')
  const text = normalizeDefText(body).trim()
  return `${lines.join('\n')}\n${text ? `\n${text}\n` : ''}`
}

/** Hire: the exact text main writes for roles/<id>.md, then re-trusts its hash. */
export function serializeRole(role: RoleDefinition): string {
  return fileText(
    [
      ['name', role.name],
      ['kind', role.kind],
      ['provider', role.provider],
      ['model', role.model],
      ['effort', role.effort],
      ['permission', role.permission],
      ['allowedTools', role.permission === 'custom' && role.allowedTools && role.allowedTools.length > 0 ? role.allowedTools.join(', ') : undefined],
      ['count', role.count],
    ],
    role.instructions,
  )
}

/** Draft -> exact files main writes (team.md, roles/<id>.md of enabled roles, routines/daily-summary.md). Deterministic. */
export function renderTeamFiles(draft: TeamSetupDraft): DefFile[] {
  const lang: Lang = draft.lang === 'en' ? 'en' : 'es'
  const t = TEMPLATE[lang]
  const goal = normalizeDefText(draft.goal).trim()
  const rules = normalizeDefText(draft.rules ?? '').trim()
  const body = rules ? `${goal}\n\n## ${lang === 'es' ? 'Reglas' : 'Rules'}\n\n${rules}` : goal
  const files: DefFile[] = [
    {
      rel: 'team.md',
      text: fileText(
        [
          ['name', draft.name],
          ['baseBranch', draft.baseBranch ? oneLine(draft.baseBranch) || undefined : undefined],
          ['verify', draft.verify ? oneLine(draft.verify) || undefined : undefined],
          ['maxConcurrent', draft.maxConcurrent],
          ['leadApprovesSmallPlans', draft.leadApprovesSmallPlans],
        ],
        body,
      ),
    },
  ]
  for (const r of draft.roles) {
    if (!r.enabled) continue
    const role: RoleDefinition = {
      id: r.id,
      name: r.name,
      kind: r.kind,
      provider: r.provider,
      permission: r.permission,
      count: r.kind === 'lead' ? 1 : r.count,
      instructions: t.instructions[r.kind],
    }
    if (r.model && r.model !== 'default') role.model = r.model
    if (r.effort) role.effort = r.effort
    files.push({ rel: `roles/${r.id}.md`, text: serializeRole(role) })
  }
  if (draft.dailySummary) {
    const lead = draft.roles.find((r) => r.enabled && r.kind === 'lead')
    files.push({
      rel: `routines/${DAILY_SUMMARY_ID}.md`,
      text: fileText(
        [
          ['cron', DAILY_SUMMARY_CRON],
          ['action', 'wake'],
          ['role', lead?.id ?? 'lead'],
          ['title', t.summaryTitle],
        ],
        t.summaryPrompt,
      ),
    })
  }
  return files
}

/** = renderTeamFiles(defaultDraft(lang)). */
export function defaultTemplate(lang: 'es' | 'en'): DefFile[] {
  return renderTeamFiles(defaultDraft(lang))
}
