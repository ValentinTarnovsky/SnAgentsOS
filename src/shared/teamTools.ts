/**
 * The `snaos team` tools (app 2.7.0, Tanda B, design 2.7 and 5.3): one table
 * that main's handler (teamCtl), the CLI guide (agentGuide), the system text
 * of every run (teamPrompt) and the Codex block parser read. Pure and
 * zod-free, no Node or DOM: the CLI entry bundles it next to main (teams.ts,
 * its only runtime import, holds constants and type-only imports).
 *
 * allowedFor decides by role and run mode; the store re-checks the task
 * phase, the run liveness, the caps and what the user owns.
 */
import type { AgentProvider } from './types'
import type { Isolation, PermissionProfile, RoleKind, RunMode, TerminalTool } from './teams'
import { TEAM_BLOCK_ACTIONS_MAX, TEAM_BLOCK_MAX_BYTES } from './teams'

export type TeamToolName = 'show' | 'tasks' | 'task.get' | 'diff' | 'log' | 'task.create' | 'task.update' | 'comment' | 'note'
  | 'ask' | 'needs' | 'plan' | 'review' | 'verdict' | 'done' | 'approve' | 'hire'
export type TeamCtlMethod = `team.${TeamToolName}`
export interface TeamToolSpec {
  name: TeamToolName; method: TeamCtlMethod
  terminal: TerminalTool | null; write: boolean
  roles: readonly RoleKind[]
  modes: readonly RunMode[]                        // run modes that may call it ([] = any)
  requires?: 'parentTask' | 'mainIsolation' | 'smallPlan'
  usage: string                                    // `snaos team plan --file - [--small]`
  summary: string                                  // one English line for the guide
}

const ALL: readonly RoleKind[] = ['lead', 'dev', 'qa', 'research', 'custom']

/**
 * Section 5.3 table. `requires`: parentTask binds the non-Lead roles (a subtask of the run's own task), mainIsolation
 * binds a Dev (allowedFor checks both as far as the run context tells), smallPlan is the store's check.
 */
export const TEAM_TOOLS: readonly TeamToolSpec[] = [
  { name: 'show', method: 'team.show', terminal: null, write: false, roles: ALL, modes: [],
    usage: 'snaos team show', summary: 'Your team, your role, this run and its task.' },
  { name: 'tasks', method: 'team.tasks', terminal: null, write: false, roles: ALL, modes: [],
    usage: 'snaos team tasks [--state todo|doing|review|done|blocked|cancelled|open] [--mine]', summary: 'The tasks of the board (200 at most).' },
  { name: 'task.get', method: 'team.task.get', terminal: null, write: false, roles: ALL, modes: [],
    usage: 'snaos team task get <t-N>', summary: 'One task with its plan and its newest 30 comments.' },
  // B5 integration (security): the readonly profile has no git log, diff or show, so main reads them for every run.
  { name: 'diff', method: 'team.diff', terminal: null, write: false, roles: ALL, modes: [],
    usage: 'snaos team diff [--stat] [--task <t-N>] [-- <path>...]',
    summary: 'The code changes of a task: its worktree against its base (commits and uncommitted changes), or the repo root against HEAD. Your own task by default; --stat for the files only.' },
  { name: 'log', method: 'team.log', terminal: null, write: false, roles: ALL, modes: [],
    usage: 'snaos team log [-n <1..50>] [--task <t-N>] [-- <path>...]',
    summary: 'The commits of a task branch since its base, or the history of the repo root (20 by default).' },
  { name: 'task.create', method: 'team.task.create', terminal: null, write: true, roles: ['lead', 'dev', 'custom'], modes: ['lead', 'exec'], requires: 'parentTask',
    usage: 'snaos team task create --title <text> [--body-file <file>|-] [--assign <agent>] [--repo <id>] [--isolation worktree|main] [--blocked-by t-1,t-2] [--priority urgent|high|normal|low] [--no-plan] [--parent <t-N>]',
    summary: 'Create a task; --blocked-by when it waits on others.' },
  { name: 'task.update', method: 'team.task.update', terminal: null, write: true, roles: ['lead'], modes: ['lead'],
    usage: 'snaos team task update <t-N> [--rev <n>] [--title <text>] [--body-file <file>|-] [--assign <agent>|none] [--priority urgent|high|normal|low] [--blocked-by t-1,t-2|none] [--isolation worktree|main] [--state todo|blocked|cancelled] [--no-plan|--needs-plan]',
    summary: 'Change a task; a field the user set stays theirs (user_owned).' },
  { name: 'comment', method: 'team.comment', terminal: null, write: true, roles: ALL, modes: [],
    usage: 'snaos team comment <t-N|lead> [<text...>] [--file <file>|-]', summary: 'Comment on a task, or write in the Lead thread with `lead`.' },
  { name: 'note', method: 'team.note', terminal: null, write: true, roles: ['lead'], modes: ['lead', 'free'],
    usage: 'snaos team note [--title <text>] [<text...>] [--file <file>|-]', summary: 'Write a team note (the daily summary, for example).' },
  { name: 'ask', method: 'team.ask', terminal: 'ask', write: true, roles: ALL, modes: [],
    usage: 'snaos team ask [<text...>] [--file <file>|-] [--options "A|B|C"] [--multi] [--confirm]', summary: 'Ask the user a question, with options when there are a few clear answers.' },
  { name: 'needs', method: 'team.needs', terminal: 'needs', write: true, roles: ALL, modes: [],
    usage: 'snaos team needs [<text...>] [--file <file>|-]', summary: 'Tell the user what you need them to do before you can go on.' },
  { name: 'plan', method: 'team.plan', terminal: 'plan', write: true, roles: ['dev', 'research', 'custom'], modes: ['plan'],
    usage: 'snaos team plan --file <file>|- [--small]', summary: 'Send your plan for approval; --small for a small change.' },
  { name: 'review', method: 'team.review', terminal: 'review', write: true, roles: ['dev', 'custom'], modes: ['exec'],
    usage: 'snaos team review [<text...>] [--file <file>|-]', summary: 'Ask for review of your committed work, with a short summary.' },
  { name: 'verdict', method: 'team.verdict', terminal: 'verdict', write: true, roles: ['qa'], modes: ['qa'],
    usage: 'snaos team verdict approve|changes [<text...>] [--file <file>|-]', summary: 'Approve the work, or ask for changes with a concrete list.' },
  { name: 'done', method: 'team.done', terminal: 'done', write: true, roles: ['research', 'custom', 'dev'], modes: ['plan', 'exec'], requires: 'mainIsolation',
    usage: 'snaos team done [<text...>] [--file <file>|-]', summary: 'Report the task finished, with your report.' },
  { name: 'approve', method: 'team.approve', terminal: 'approvePlan', write: true, roles: ['lead'], modes: ['lead'], requires: 'smallPlan',
    usage: 'snaos team approve --plan <t-N>', summary: 'Approve a small plan you read in full (the user decides the rest).' },
  { name: 'hire', method: 'team.hire', terminal: 'hire', write: true, roles: ['lead'], modes: ['lead'],
    usage: 'snaos team hire --file <file>|-', summary: 'Propose a new role (a full role file: frontmatter and instructions) for the user to approve. An optional `id: <role-id>` line in the frontmatter names the role; without it the id is the slug of `name` (`QA Movil` -> `qa-movil`).' },
]

export const TEAM_CTL_METHODS: readonly TeamCtlMethod[] = TEAM_TOOLS.map((t) => t.method)

export function teamTool(method: string): TeamToolSpec | null {
  return TEAM_TOOLS.find((t) => t.method === method) ?? null
}

export function isTeamMethod(m: string): m is TeamCtlMethod {
  return typeof m === 'string' && (TEAM_CTL_METHODS as readonly string[]).includes(m)
}

/**
 * Role, mode and requirement check (section 5.3); the store re-checks phase and liveness. `profile` is the run's
 * permission profile (Run.profile): in an exec run it is the role's own, while a plan run is readonly whatever the
 * role (effectiveProfile).
 */
export function allowedFor(kind: RoleKind, spec: TeamToolSpec, ctx: { mode: RunMode; isolation?: Isolation; hasTask: boolean; profile?: PermissionProfile }): boolean {
  if (!spec.roles.includes(kind)) return false
  if (spec.modes.length > 0 && !spec.modes.includes(ctx.mode)) return false
  switch (spec.name) {
    case 'task.create':
      // The Lead plans from its own runs; a Dev or a custom role only splits the task it runs (`--parent`, the store checks it is that one).
      return kind === 'lead' ? ctx.mode === 'lead' : ctx.mode === 'exec' && ctx.hasTask
    case 'done':
      // A Dev closes only a task with nothing to integrate: isolation main, or an exec run of a readonly role (its
      // worktree task runs in the repo root and commits nothing, decision 24). A writing Dev's plan run is readonly
      // only for its phase: it never closes the task. Research may close from its plan run too.
      if (kind === 'dev' && ctx.isolation !== 'main' && !(ctx.mode === 'exec' && ctx.profile === 'readonly')) return false
      return kind === 'research' || ctx.mode === 'exec'
    case 'review':
      // A readonly exec run commits nothing, so there is nothing to review: it reports with `team done`.
      return ctx.profile !== 'readonly'
    default:
      return true
  }
}

const MODE_WORD: Readonly<Record<RunMode, string>> = { plan: 'plan', exec: 'exec', qa: 'QA', lead: 'Lead', free: 'free' }

/** When a role may call a tool, as the guide says it ('' = any run of that role). */
function whenOf(kind: RoleKind, spec: TeamToolSpec): string {
  if (kind === 'lead') return ''
  if (spec.name === 'task.create') return 'exec runs, only a subtask of your task: --parent <your task>'
  if (spec.name === 'done') return kind === 'research' ? 'plan or exec runs' : kind === 'dev' ? 'exec runs of a task with isolation main, or any exec run when your role is read-only' : 'exec runs'
  if (spec.name === 'review') return 'exec runs, when your role may write'
  return spec.modes.length === 0 ? '' : `${spec.modes.map((m) => MODE_WORD[m]).join(' or ')} runs`
}

/** The role's methods (name, usage, summary), channel neutral: part of systemText, so it is in sysHash (decision 33). */
export function teamToolsGuide(kind: RoleKind): string {
  const lines = [`Team tools of your role (${kind}). Each one is a method \`team.<name>\`; your run instructions say how to call them.`]
  for (const spec of TEAM_TOOLS) {
    if (!spec.roles.includes(kind)) continue
    const notes = [whenOf(kind, spec), spec.terminal ? 'ends your run' : ''].filter((n) => n !== '')
    lines.push(`- ${spec.method}${notes.length ? ` (${notes.join('; ')})` : ''}: \`${spec.usage}\`. ${spec.summary}`)
  }
  lines.push('End every run with exactly one tool that ends your run; after it, the team refuses your other writes.')
  return lines.join('\n')
}

const FENCE = '```'

/** Params of each write method for the Codex block contract (`?` = optional). */
const BLOCK_PARAMS: ReadonlyArray<readonly [TeamCtlMethod, string]> = [
  ['team.task.create', '{title, body?, assign?: <agent id>, repo?, isolation?: "worktree" or "main", blockedBy?: ["t-1"], priority?: "urgent", "high", "normal" or "low", noPlan?: true, parent?: <task id>}'],
  ['team.task.update', '{task, rev?, title?, body?, assign?: <agent id>, priority?, blockedBy?: [] to clear, isolation?, state?: "todo", "blocked" or "cancelled", needsPlan?: true or false}'],
  ['team.comment', '{target: <task id> or "lead", text}'],
  ['team.note', '{text, title?}'],
  ['team.ask', '{text, options?: ["A", "B"], multi?: true, confirm?: true}'],
  ['team.needs', '{text}'],
  ['team.plan', '{text, small?}'],
  ['team.review', '{text?}'],
  ['team.verdict', '{verdict: "approve" or "changes", text}'],
  ['team.done', '{text?}'],
  ['team.approve', '{plan: <task id>}'],
  ['team.hire', '{text: <the full role file; an optional `id:` frontmatter line names the role, else the slug of `name`>}'],
]

/**
 * The per-run channel text of stdin section 4 (never in the system text): reportsByBlock false -> "call them as
 * `snaos team <...> --json`" plus, when win32, "for long text write a UTF-8 file outside your cwd (for example under
 * $env:TEMP) with your edit tool and pass --file <path>; never pipe non-ASCII text in Windows PowerShell"; true -> the
 * 5.6 block contract and grammar.
 *
 * Claude (the default, also the CLI guide's) calls them with its Bash tool only: its allow lists carry
 * `Bash(snaos team:*)` and never the PowerShell twin (teamArgv CLAUDE_TEAM_TOOLS, E10 SPIKE), so its Windows advice
 * offers a Bash heredoc first and names $TEMP. A Codex run that calls the CLI is `danger-full-access` and calls it
 * from its own shell.
 */
export function teamChannelText(reportsByBlock: boolean, o: { win32: boolean; provider?: AgentProvider }): string {
  if (!reportsByBlock) {
    const claude = (o.provider ?? 'claude') === 'claude'
    const lines = [
      claude
        ? 'Call the team tools with your Bash tool as `snaos team <tool> ... --json` (for example `snaos team show --json`), never with the PowerShell tool: this run does not allow `snaos team` there. Each call prints one JSON line: `{"ok":true,"data":...}` or `{"ok":false,"error":{"code":...,"message":...}}`.'
        : 'Call the team tools from your shell as `snaos team <tool> ... --json` (for example `snaos team show --json`). Each call prints one JSON line: `{"ok":true,"data":...}` or `{"ok":false,"error":{"code":...,"message":...}}`.',
      'Long text goes in a file: `--file <path>` (`--body-file <path>` for a task body), or `-` to read it from stdin.',
    ]
    if (o.win32) {
      lines.push(
        claude
          ? "On Windows, for long or non-ASCII text use a Bash heredoc (`snaos team plan --file - <<'EOF'` ... `EOF`), or write a UTF-8 file outside your cwd (for example under $TEMP) with your edit tool and pass --file <path>; never pipe non-ASCII text in Windows PowerShell (it turns it into ?)."
          : "On Windows, for long or non-ASCII text write a UTF-8 file outside your cwd (for example under $env:TEMP) with your edit tool and pass --file <path>, or use a Bash heredoc (`snaos team plan --file - <<'EOF'` ... `EOF`); never pipe non-ASCII text in Windows PowerShell (it turns it into ?).",
      )
    }
    return lines.join('\n')
  }
  return [
    'You cannot run `snaos team` in this sandbox. End your LAST message with exactly one fenced block (use four backticks when the text inside has code fences):',
    '',
    `${FENCE}snaos-team`,
    '{"v":1,"actions":[{"method":"team.comment","params":{"target":"t-12","text":"..."}},{"method":"team.plan","params":{"text":"...","small":true}}]}',
    FENCE,
    '',
    `Rules: one JSON object \`{"v":1,"actions":[...]}\` (it may span several lines), at most ${Math.floor(TEAM_BLOCK_MAX_BYTES / 1024)} KB and ${TEAM_BLOCK_ACTIONS_MAX} actions. Only write methods, and only the ones your team tools list; their params (? = optional):`,
    ...BLOCK_PARAMS.map(([method, params]) => `- ${method} ${params}`),
    'At most one tool that ends your run, and only as the last action. Reads (team.show, team.tasks, team.task.get, team.diff, team.log) are not available here: what you need is in this prompt.',
    'A task id param (task, target, parent or an item of blockedBy) written exactly "$1" names the task that the 1st action of the same block created with team.task.create ("$2" the 2nd, and so on).',
    'The app applies the actions in order when your run ends; the first one it refuses stops the rest. Without the block, nothing you decided reaches the team.',
  ].join('\n')
}

export interface TeamBlock { v: 1; actions: Array<{ method: TeamCtlMethod; params: Record<string, unknown> }> }

/** A line that opens a fenced block (CommonMark): up to 3 spaces, 3+ backticks or tildes, then the info string. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** A line that closes one: up to 3 spaces, 3+ of the same char, then only spaces or tabs. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

function plainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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

/**
 * Fence grammar (5.6): an opening line made of up to 3 spaces, a run of N >= 3 backticks and the info string exactly
 * `snaos-team` (trailing spaces allowed); closed by the next line made only of up to 3 spaces and >= N backticks
 * (CommonMark), so a plan with ``` code fences inside travels in a ```` fence. The body is one JSON object across any
 * number of lines. The LAST complete block wins (an unclosed one is ignored): `{v:1, actions}`, <= TEAM_BLOCK_MAX_BYTES,
 * <= TEAM_BLOCK_ACTIONS_MAX actions, only write methods, at most one terminal and only last. Else null.
 *
 * Other fences are tracked too (CommonMark), so a `snaos-team` line inside another code block, a quoted example,
 * opens nothing. Refs (TEAM_BLOCK_REF_RE) stay as written: applyBlock resolves them in order.
 */
export function parseTeamBlock(text: string): TeamBlock | null {
  if (typeof text !== 'string' || text === '') return null
  let open: { char: string; len: number; team: boolean; body: string[] } | null = null
  let last: string | null = null
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (open) {
      const close = FENCE_CLOSE_RE.exec(line)
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        if (open.team) last = open.body.join('\n')
        open = null
      } else if (open.team) open.body.push(line)
      continue
    }
    const m = FENCE_OPEN_RE.exec(line)
    if (!m) continue
    const char = m[1][0]
    // A backtick fence's info string has no backtick (CommonMark): "```a```" is inline code, not a fence.
    if (char === '`' && m[2].includes('`')) continue
    open = { char, len: m[1].length, team: char === '`' && m[2].trim() === 'snaos-team', body: [] }
  }
  return last === null ? null : blockOf(last)
}

function blockOf(body: string): TeamBlock | null {
  if (utf8Bytes(body) > TEAM_BLOCK_MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!plainObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.actions)) return null
  const actions = parsed.actions as unknown[]
  if (actions.length === 0 || actions.length > TEAM_BLOCK_ACTIONS_MAX) return null
  const out: TeamBlock['actions'] = []
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    if (!plainObject(a) || typeof a.method !== 'string') return null
    const spec = teamTool(a.method)
    if (!spec || !spec.write) return null
    if (spec.terminal && i !== actions.length - 1) return null
    const params = a.params === undefined ? {} : a.params
    if (!plainObject(params)) return null
    out.push({ method: spec.method, params })
  }
  return { v: 1, actions: out }
}

/** A string param exactly `$<n>` (n = 1-based index of an earlier `team.task.create` action of the same block) names the id that action returned; only in task-id params (`task`, `target`, `parent`, `blockedBy[]`). */
export const TEAM_BLOCK_REF_RE = /^\$([1-9][0-9]?)$/
