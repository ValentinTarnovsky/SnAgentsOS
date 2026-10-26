/**
 * Pure helpers of the per-repo `.snagentsos.json` (E8-FR-23..27): file ->
 * workspace draft, workspace -> file, the trust dialog lines and the one-time
 * setup launch. No store, no IPC: testable in the vm harness.
 */
import type { AgentPreset, ConnectionProfile, GridPreset, Pane, QuickCommand, Workspace } from '@shared/types'
import {
  REPO_CONFIG_MAX_CONSOLES,
  REPO_CONFIG_MAX_QUICK,
  type RepoConfigConsole,
  type RepoConfigFile,
  type RepoConfigQuick,
  type RepoConfigReadRes,
} from '@shared/repo-config'
import { QUICK_COMMANDS_MAX } from '@shared/quickCommands'
import { shellKind } from '@shared/shellKind'
import { gridForCount, orderPanes } from '@/components/layout/gridTemplates'
import type { MessageKey } from '@/i18n'
import type { DraftQuickCommand, WorkspaceDraft, WorkspaceDraftPane } from '@/lib/store'

/** A localized, non-blocking finding shown on the card or the export dialog. */
export interface RepoWarning {
  key: MessageKey
  vars?: Record<string, string | number>
}

const SHELL_COLOR = '#6366f1'
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20})$/
const ICON_RE = /^[a-zA-Z0-9-]{1,40}$/

/**
 * Which local preset a file's `agent` names: a preset name (case-insensitive)
 * first, then the `claude` / `codex` / `shell` keywords (first preset of that
 * type). Unknown falls back to a shell (E8-FR-23).
 */
export function resolveRepoAgent(agent: string | undefined, presets: AgentPreset[]): { preset?: AgentPreset; unknown: boolean } {
  const name = agent?.trim().toLowerCase() ?? ''
  if (!name || name === 'shell') return { preset: presets.find((p) => p.type === 'shell'), unknown: false }
  const byName = presets.find((p) => p.name.trim().toLowerCase() === name)
  if (byName) return { preset: byName, unknown: false }
  if (name === 'claude' || name === 'codex') {
    const byType = presets.find((p) => p.type === name)
    if (byType) return { preset: byType, unknown: false }
  }
  return { preset: presets.find((p) => p.type === 'shell'), unknown: true }
}

/** The portable name a preset is exported under: the type keyword for the first of its type. */
export function exportAgentName(preset: AgentPreset, presets: AgentPreset[]): string {
  const first = presets.find((p) => p.type === preset.type)
  if (first?.id === preset.id && (preset.type === 'claude' || preset.type === 'codex' || preset.type === 'shell')) return preset.type
  return preset.name
}

/**
 * How the setup console runs its command once (E8-FR-25): as the shell's own
 * argument, so the shell exits with the command's code. A shell we cannot
 * drive that way, or a connection profile (the command must run after the
 * login), types it instead and its exit cannot release anything. cmd.exe
 * gets a raw command line: `/s` strips the outer quotes and keeps the inner
 * ones, which node-pty's array quoting (`\"`) would break.
 */
export function oneShotLaunch(
  command: string,
  shell: string | undefined,
  platform: string,
  hasProfile: boolean,
): { args?: string[] | string; initialCommand?: string } {
  if (hasProfile) return { initialCommand: command }
  const kind = shell?.trim() ? shellKind(shell, platform) : platform === 'win32' ? 'powershell' : 'posix'
  switch (kind) {
    case 'powershell':
      return { args: ['-NoLogo', '-Command', command] }
    case 'cmd':
      return { args: `/d /s /c "${command}"` }
    case 'posix':
      return { args: ['-lc', command] }
    default:
      return { initialCommand: command }
  }
}

export interface RepoDraftInput {
  /** The repo folder (workspace cwd). */
  dir: string
  /** A read with status 'ok'. */
  res: RepoConfigReadRes
  presets: AgentPreset[]
  connections: ConnectionProfile[]
  /** Profile picked on the card ('' = none). */
  profileId: string
  /** Quick Commands that stay after the import (the cap is 100 in total). */
  quickCount: number
  /** Configured default shell for this OS (undefined = the OS default). */
  shell: string | undefined
  platform: string
}

export interface RepoDraft {
  draft: WorkspaceDraft
  warnings: RepoWarning[]
  /** Repo Quick Commands left out by the 100 limit. */
  skippedQuick: number
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

function consolePane(c: RepoConfigConsole, i: number, presets: AgentPreset[], cwd: string | null, warnings: RepoWarning[]): WorkspaceDraftPane {
  const { preset, unknown } = resolveRepoAgent(c.agent, presets)
  if (unknown) warnings.push({ key: 'repo.warn.unknownAgent', vars: { at: `consoles[${i}].agent`, agent: c.agent ?? '' } })
  const command = c.command?.trim() ? c.command : undefined
  return {
    type: preset?.type ?? 'shell',
    presetId: preset?.id,
    title: c.title?.trim() || preset?.name || 'Shell',
    color: c.color ?? preset?.color ?? SHELL_COLOR,
    icon: c.icon ?? preset?.icon ?? 'terminal',
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(c.prompt?.trim() ? { prompt: c.prompt } : {}),
  }
}

function quickFrom(q: RepoConfigQuick, i: number, presets: AgentPreset[], warnings: RepoWarning[]): DraftQuickCommand | null {
  if (q.action === 'send') return { name: q.label.trim(), text: q.text, action: 'send', enter: q.enter === true }
  const { preset, unknown } = resolveRepoAgent(q.agent, presets)
  if (unknown || !preset || preset.type === 'shell') {
    warnings.push({ key: 'repo.warn.unknownQuickAgent', vars: { at: `quickCommands[${i}].agent`, agent: q.agent } })
    return null
  }
  return { name: q.label.trim(), text: q.prompt, action: 'agent', enter: true, presetId: preset.id }
}

/**
 * The workspace a repo file creates (E8-FR-25): name (or the folder's
 * basename), the grid (or the smallest that fits), the consoles in order with
 * their checked cwd, the picked profile, the setup console and the Quick
 * Commands up to the 100 cap. Warnings are what the card shows.
 */
export function draftFromRepoConfig(input: RepoDraftInput): RepoDraft {
  const cfg = input.res.config as RepoConfigFile
  const warnings: RepoWarning[] = []
  for (const w of input.res.warnings) if (w.code === 'cwd_missing') warnings.push({ key: 'repo.warn.cwdMissing', vars: { at: w.at } })
  const cwds = input.res.consoleCwds ?? []
  const panes = cfg.consoles.slice(0, REPO_CONFIG_MAX_CONSOLES).map((c, i) => consolePane(c, i, input.presets, cwds[i] ?? null, warnings))

  const profile = input.profileId ? input.connections.find((c) => c.id === input.profileId) : undefined
  if (cfg.connectionProfile && !input.connections.some((c) => c.name === cfg.connectionProfile)) {
    warnings.push({ key: 'repo.warn.profileMissing', vars: { name: cfg.connectionProfile } })
  }

  let setup: WorkspaceDraft['setup']
  if (cfg.setup) {
    const shot = oneShotLaunch(cfg.setup.command, input.shell, input.platform, !!profile)
    const observable = !!shot.args
    if (cfg.setup.waitForSetup && !observable) warnings.push({ key: 'repo.warn.setupNoWait' })
    setup = { command: cfg.setup.command, title: cfg.setup.title, wait: cfg.setup.waitForSetup === true && observable }
  }

  const total = panes.length + (setup ? 1 : 0)
  let grid: GridPreset = gridForCount(total)
  if (cfg.grid) {
    if (cfg.grid >= total) grid = cfg.grid
    else warnings.push({ key: 'repo.warn.gridSmall', vars: { grid: cfg.grid, count: total } })
  }

  const quick: DraftQuickCommand[] = []
  ;(cfg.quickCommands ?? []).slice(0, REPO_CONFIG_MAX_QUICK).forEach((q, i) => {
    const item = quickFrom(q, i, input.presets, warnings)
    if (item) quick.push(item)
  })
  const room = Math.max(0, QUICK_COMMANDS_MAX - input.quickCount)
  const skippedQuick = Math.max(0, quick.length - room)
  if (skippedQuick > 0) warnings.push({ key: 'repo.warn.quickSkipped', vars: { count: skippedQuick } })

  return {
    draft: {
      name: cfg.name?.trim() || basename(input.dir) || 'workspace',
      cwd: input.dir,
      grid,
      panes,
      setupId: profile?.id,
      ...(setup ? { setup } : {}),
      quickCommands: quick.slice(0, room),
      repoConfig: { sha256: input.res.sha256 ?? '' },
    },
    warnings,
    skippedQuick,
  }
}

/** Lower-case drive letter, forward slashes, `.`/`..` folded, no trailing slash. */
function normAbs(p: string): string[] | null {
  const parts: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length <= 1) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts
}

/**
 * `target` relative to `repo` with `/` separators: '' for the repo itself,
 * null when it is not inside (E8-FR-26 omits those cwds with a warning).
 * Case-insensitive on Windows.
 */
export function relativeInside(repo: string, target: string, platform: string): string | null {
  const a = normAbs(repo)
  const b = normAbs(target)
  if (!a || !b || a.length === 0 || b.length < a.length) return null
  const eq = platform === 'win32' ? (x: string, y: string) => x.toLowerCase() === y.toLowerCase() : (x: string, y: string) => x === y
  // A POSIX root path keeps its leading slash meaning: compare both kinds alike.
  const rootA = repo.replace(/\\/g, '/').startsWith('/')
  const rootB = target.replace(/\\/g, '/').startsWith('/')
  if (rootA !== rootB) return null
  for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return null
  return b.slice(a.length).join('/')
}

export interface RepoExport {
  file: RepoConfigFile
  warnings: RepoWarning[]
  /** Quick Commands written to the file (they become the workspace's repo ones). */
  quickCommandIds: string[]
}

/**
 * The `.snagentsos.json` of a workspace (E8-FR-26): name, grid, consoles
 * (preset by name, own command, title, color, icon and a cwd relative to the
 * repo when it differs and stays inside), the profile by name only (never its
 * steps or secrets) and the workspace's own Quick Commands.
 */
export function repoConfigFromWorkspace(
  ws: Workspace,
  presets: AgentPreset[],
  connections: ConnectionProfile[],
  quickCommands: QuickCommand[],
  platform: string,
): RepoExport {
  const warnings: RepoWarning[] = []
  const panes: Pane[] = orderPanes(ws.panes, ws.layout?.order).slice(0, REPO_CONFIG_MAX_CONSOLES)
  const consoles: RepoConfigConsole[] = panes.map((p) => {
    const c: RepoConfigConsole = {}
    if (p.title.trim()) c.title = p.title.trim().slice(0, 60)
    const preset = p.presetId ? presets.find((x) => x.id === p.presetId) : undefined
    if (preset && preset.type !== 'shell') c.agent = exportAgentName(preset, presets)
    else if (preset && exportAgentName(preset, presets) !== 'shell') c.agent = preset.name
    if (p.command?.trim()) c.command = p.command
    if (p.cwd && p.cwd !== ws.cwd) {
      const rel = relativeInside(ws.cwd, p.cwd, platform)
      if (rel === null) warnings.push({ key: 'repo.warn.cwdOutside', vars: { title: p.title } })
      else if (rel) c.cwd = rel
    }
    if (COLOR_RE.test(p.color)) c.color = p.color
    if (ICON_RE.test(p.icon)) c.icon = p.icon
    return c
  })
  const ids: string[] = []
  const quick: RepoConfigQuick[] = []
  for (const qc of quickCommands) {
    if (qc.workspaceId !== ws.id) continue
    if (quick.length >= REPO_CONFIG_MAX_QUICK) {
      warnings.push({ key: 'repo.warn.quickTruncated', vars: { max: REPO_CONFIG_MAX_QUICK } })
      break
    }
    const label = qc.name.trim().slice(0, 60)
    if (qc.action === 'send') quick.push({ label, action: 'send', text: qc.text, ...(qc.enter ? { enter: true } : {}) })
    else {
      const preset = presets.find((x) => x.id === qc.presetId)
      if (!preset) {
        warnings.push({ key: 'repo.warn.quickNoPreset', vars: { label } })
        continue
      }
      quick.push({ label, action: 'agent', agent: exportAgentName(preset, presets), prompt: qc.text })
    }
    ids.push(qc.id)
  }
  const profile = ws.setupId ? connections.find((c) => c.id === ws.setupId) : undefined
  const grid = ws.layout?.grid ?? gridForCount(consoles.length)
  const file: RepoConfigFile = {
    version: 1,
    ...(ws.name.trim() ? { name: ws.name.trim().slice(0, 80) } : {}),
    grid: grid >= consoles.length ? grid : gridForCount(consoles.length),
    ...(profile ? { connectionProfile: profile.name.slice(0, 80) } : {}),
    consoles: consoles.length > 0 ? consoles : [{}],
    ...(quick.length > 0 ? { quickCommands: quick } : {}),
  }
  return { file, warnings, quickCommandIds: ids }
}

/** One executable line of the trust dialog (E8-FR-24), localized by the dialog. */
export type TrustItem =
  | { kind: 'profile'; name: string; count: number }
  | { kind: 'setup'; command: string }
  | { kind: 'command'; index: number; title: string; command: string }
  | { kind: 'agent'; index: number; title: string; agent: string; prompt?: string }
  | { kind: 'quickSend'; label: string; text: string; enter: boolean }
  | { kind: 'quickAgent'; label: string; agent: string; prompt: string }

/**
 * Characters that hide or reorder what a line shows (E8-FR-24): C0/C1
 * controls (newline and tab stay), bidi overrides and isolates (a
 * "Trojan Source" command reads differently than it runs) and zero-width
 * marks. The trust dialog shows them as `<U+XXXX>` instead.
 */
const HIDDEN_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu

/** `text` with every hiding character spelled out, so the dialog shows what runs. */
export function visibleText(text: string): string {
  return text.replace(HIDDEN_RE, (ch) => `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`)
}

/**
 * Every executable line of a file, in the dialog's order (E8-FR-24): the
 * profile first, then the setup, each console's command, each agent + prompt,
 * and each Quick Command. Every file-provided string goes through
 * `visibleText`.
 */
export function trustItemsFor(cfg: RepoConfigFile, profileName: string | undefined, consoleCount: number): TrustItem[] {
  const v = visibleText
  const out: TrustItem[] = []
  if (profileName) out.push({ kind: 'profile', name: v(profileName), count: consoleCount })
  if (cfg.setup) out.push({ kind: 'setup', command: v(cfg.setup.command) })
  cfg.consoles.forEach((c, index) => {
    const title = v(c.title?.trim() || `#${index + 1}`)
    if (c.command?.trim()) out.push({ kind: 'command', index, title, command: v(c.command) })
  })
  cfg.consoles.forEach((c, index) => {
    const title = v(c.title?.trim() || `#${index + 1}`)
    const agent = c.agent?.trim() || 'shell'
    if (agent.toLowerCase() !== 'shell' || c.prompt?.trim()) {
      out.push({ kind: 'agent', index, title, agent: v(agent), ...(c.prompt?.trim() ? { prompt: v(c.prompt) } : {}) })
    }
  })
  for (const q of cfg.quickCommands ?? []) {
    if (q.action === 'send') out.push({ kind: 'quickSend', label: v(q.label), text: v(q.text), enter: q.enter === true })
    else out.push({ kind: 'quickAgent', label: v(q.label), agent: v(q.agent), prompt: v(q.prompt) })
  }
  return out
}

/**
 * Whether opening needs the dialog (E8-FR-24): an executable file whose hash
 * is not approved, or a profile picked by hand on the card (always, even on a
 * trusted hash: the file did not ask for it).
 */
export function trustDialogNeeded(res: RepoConfigReadRes, profileName: string | undefined): { dialog: boolean; store: boolean } {
  const store = res.needsTrust && !res.trusted
  const manualProfile = !!profileName && profileName !== res.config?.connectionProfile
  return { dialog: store || manualProfile, store }
}

/** "N consoles (titles), grid G, setup: <first 60>" parts for the card (E8-FR-23). */
export function repoSummary(cfg: RepoConfigFile): { count: number; titles: string; grid: number; setup: string | null } {
  const titles = cfg.consoles.map((c, i) => c.title?.trim() || c.agent?.trim() || `#${i + 1}`).join(', ')
  const count = cfg.consoles.length + (cfg.setup ? 1 : 0)
  const grid = cfg.grid && cfg.grid >= count ? cfg.grid : gridForCount(count)
  const cmd = cfg.setup?.command.replace(/\s+/g, ' ').trim() ?? null
  return { count: cfg.consoles.length, titles, grid, setup: cmd === null ? null : cmd.length > 60 ? `${cmd.slice(0, 60)}...` : cmd }
}
