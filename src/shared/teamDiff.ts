/**
 * What changed in a team definition (app 2.7.0, Tanda B): the line diff the
 * trust and hire dialogs show, and the security-relevant changes they flag.
 * Pure, no Node or DOM. Hunks have the ChatPatchHunk shape, so the desktop
 * patch block of the console chat and the phone DiffBlock render them as is.
 */
import type { ChatPatchHunk } from './chat-types'
import { CHAT_PATCH_MAX_LINES } from './chat-types'
import type { AgentProvider } from './types'
import type { DefFile, PermissionProfile, TeamDefinition } from './teams'

export interface TeamFileDiff { rel: string; status: 'added' | 'removed' | 'changed'; hunks: ChatPatchHunk[]; add: number; del: number; truncated?: boolean }
export type TeamRiskFlag =
  | { code: 'permissionUp'; roleId: string; from: PermissionProfile | null; to: PermissionProfile }
  | { code: 'toolsAdded'; roleId: string; tools: string[] }
  | { code: 'providerChanged'; roleId: string; from: AgentProvider; to: AgentProvider }
  | { code: 'countUp'; roleId: string; from: number; to: number }
  | { code: 'verifyChanged'; repoId: string; from?: string; to?: string }
  | { code: 'extraRepo'; repoId: string; path: string }
  | { code: 'routineAdded'; routineId: string; cron: string; action: 'wake' | 'task' }
  | { code: 'instructionsChanged'; roleId: string }
export interface TeamDefinitionDiff { files: TeamFileDiff[]; risks: TeamRiskFlag[]; truncated: boolean }

const DIFF_CONTEXT = 3
/** Edit distance past which the search stops and the changed middle is shown as one replace. */
const MAX_EDIT_DISTANCE = 2000

interface Op { t: ' ' | '-' | '+'; line: string }

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Myers' O((N+M)D) shortest edit script, or null when D exceeds maxD. */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxD)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  /** trace[d] = the furthest x per diagonal k in -d..d after step d (index k + d). */
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1))
        return backtrack(a, b, trace, d)
      }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  return null
}

function backtrack(a: readonly string[], b: readonly string[], trace: readonly Int32Array[], dEnd: number): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = dEnd; d > 0; d--) {
    const prev = trace[d - 1]
    const at = (k: number): number => prev[k + d - 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[x - 1] })
      x--
      y--
    }
    if (x === prevX) {
      ops.push({ t: '+', line: b[y - 1] })
      y--
    } else {
      ops.push({ t: '-', line: a[x - 1] })
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', line: a[x - 1] })
    x--
    y--
  }
  return ops.reverse()
}

/** Common prefix and suffix kept as context, Myers on the middle, a plain replace past MAX_EDIT_DISTANCE. */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const midA = a.slice(pre, a.length - suf)
  const midB = b.slice(pre, b.length - suf)
  const mid = myers(midA, midB, MAX_EDIT_DISTANCE) ?? [
    ...midA.map((line): Op => ({ t: '-', line })),
    ...midB.map((line): Op => ({ t: '+', line })),
  ]
  return [
    ...a.slice(0, pre).map((line): Op => ({ t: ' ', line })),
    ...mid,
    ...a.slice(a.length - suf).map((line): Op => ({ t: ' ', line })),
  ]
}

function hunkOf(ops: readonly Op[], oldAt: number, newAt: number): ChatPatchHunk {
  let oldLines = 0
  let newLines = 0
  for (const op of ops) {
    if (op.t !== '+') oldLines++
    if (op.t !== '-') newLines++
  }
  return {
    oldStart: oldLines > 0 ? oldAt + 1 : oldAt,
    oldLines,
    newStart: newLines > 0 ? newAt + 1 : newAt,
    newLines,
    lines: ops.map((op) => op.t + op.line),
  }
}

/** Unified hunks: changes closer than 2 * context lines share a hunk. */
function hunksOf(ops: readonly Op[], context: number): Array<{ ops: Op[]; oldAt: number; newAt: number }> {
  const n = ops.length
  const oldAt: number[] = []
  const newAt: number[] = []
  let o = 0
  let w = 0
  for (const op of ops) {
    oldAt.push(o)
    newAt.push(w)
    if (op.t !== '+') o++
    if (op.t !== '-') w++
  }
  const out: Array<{ ops: Op[]; oldAt: number; newAt: number }> = []
  let j = 0
  while (j < n) {
    if (ops[j].t === ' ') {
      j++
      continue
    }
    const start = Math.max(0, j - context)
    let last = j
    let k = j
    while (k < n) {
      if (ops[k].t !== ' ') {
        last = k
        k++
        continue
      }
      let eq = k
      while (eq < n && ops[eq].t === ' ') eq++
      if (eq < n && eq - k <= 2 * context) k = eq
      else break
    }
    const stop = Math.min(n, last + 1 + context)
    out.push({ ops: ops.slice(start, stop), oldAt: oldAt[start], newAt: newAt[start] })
    j = stop
  }
  return out
}

/** Myers line diff, 3 lines of context, ChatPatchHunk shape; more than maxLines (default CHAT_PATCH_MAX_LINES 400) changed lines -> truncated; edit distance over 2000 -> whole-file replace. */
export function lineDiff(before: string, after: string, opts?: { context?: number; maxLines?: number }): { hunks: ChatPatchHunk[]; add: number; del: number; truncated: boolean } {
  const context = Math.max(0, opts?.context ?? DIFF_CONTEXT)
  const maxLines = Math.max(0, opts?.maxLines ?? CHAT_PATCH_MAX_LINES)
  const ops = diffOps(splitLines(before), splitLines(after))
  let add = 0
  let del = 0
  for (const op of ops) {
    if (op.t === '+') add++
    else if (op.t === '-') del++
  }
  const groups = hunksOf(ops, context)
  if (add + del <= maxLines) return { hunks: groups.map((g) => hunkOf(g.ops, g.oldAt, g.newAt)), add, del, truncated: false }
  // Keep whole hunks while they fit, then the head of the one that crosses the limit.
  const hunks: ChatPatchHunk[] = []
  let left = maxLines
  for (const g of groups) {
    const changed = g.ops.filter((op) => op.t !== ' ').length
    if (changed <= left) {
      hunks.push(hunkOf(g.ops, g.oldAt, g.newAt))
      left -= changed
      continue
    }
    const head: Op[] = []
    for (const op of g.ops) {
      if (op.t !== ' ') {
        if (left === 0) break
        left--
      }
      head.push(op)
    }
    if (head.some((op) => op.t !== ' ')) hunks.push(hunkOf(head, g.oldAt, g.newAt))
    break
  }
  return { hunks, add, del, truncated: true }
}

export function diffTeamFiles(before: readonly DefFile[], after: readonly DefFile[], opts?: { maxLinesPerFile?: number }): TeamFileDiff[] {
  const prev = new Map(before.map((f) => [f.rel, f.text]))
  const next = new Map(after.map((f) => [f.rel, f.text]))
  const rels = [...new Set([...prev.keys(), ...next.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const out: TeamFileDiff[] = []
  for (const rel of rels) {
    const a = prev.get(rel)
    const b = next.get(rel)
    if (a === b) continue
    const status: TeamFileDiff['status'] = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed'
    const d = lineDiff(a ?? '', b ?? '', { maxLines: opts?.maxLinesPerFile })
    const file: TeamFileDiff = { rel, status, hunks: d.hunks, add: d.add, del: d.del }
    if (d.truncated) file.truncated = true
    out.push(file)
  }
  return out
}

const PERMISSION_RANK: Readonly<Record<PermissionProfile, number>> = { readonly: 0, custom: 1, total: 2 }

/** Security-relevant changes from the parsed definitions (before null = first trust). Order: permissionUp, toolsAdded, providerChanged, countUp, verifyChanged, extraRepo, routineAdded, instructionsChanged. */
export function teamRiskFlags(before: TeamDefinition | null, after: TeamDefinition): TeamRiskFlag[] {
  const flags: TeamRiskFlag[] = []
  const prevRole = new Map((before?.roles ?? []).map((r) => [r.id, r]))
  for (const r of after.roles) {
    const p = prevRole.get(r.id)
    if (p ? PERMISSION_RANK[r.permission] > PERMISSION_RANK[p.permission] : r.permission !== 'readonly') {
      flags.push({ code: 'permissionUp', roleId: r.id, from: p ? p.permission : null, to: r.permission })
    }
  }
  for (const r of after.roles) {
    const had = new Set(prevRole.get(r.id)?.allowedTools ?? [])
    const tools = (r.allowedTools ?? []).filter((t) => !had.has(t))
    if (tools.length > 0) flags.push({ code: 'toolsAdded', roleId: r.id, tools })
  }
  for (const r of after.roles) {
    const p = prevRole.get(r.id)
    if (p && p.provider !== r.provider) flags.push({ code: 'providerChanged', roleId: r.id, from: p.provider, to: r.provider })
  }
  for (const r of after.roles) {
    const p = prevRole.get(r.id)
    if (p && r.count > p.count) flags.push({ code: 'countUp', roleId: r.id, from: p.count, to: r.count })
  }
  // A new or different command is the risk; dropping one is not flagged.
  const verifyFlag = (repoId: string, from: string | undefined, to: string | undefined): void => {
    if (to === undefined || to === from) return
    const flag: Extract<TeamRiskFlag, { code: 'verifyChanged' }> = { code: 'verifyChanged', repoId, to }
    if (from !== undefined) flag.from = from
    flags.push(flag)
  }
  verifyFlag('main', before?.verify, after.verify)
  const prevRepo = new Map((before?.extraRepos ?? []).map((r) => [r.id, r]))
  for (const r of after.extraRepos) verifyFlag(r.id, prevRepo.get(r.id)?.verify, r.verify)
  for (const r of after.extraRepos) {
    const p = prevRepo.get(r.id)
    if (!p || p.path !== r.path) flags.push({ code: 'extraRepo', repoId: r.id, path: r.path })
  }
  const prevRoutine = new Map((before?.routines ?? []).map((r) => [r.id, r]))
  for (const r of after.routines) {
    const p = prevRoutine.get(r.id)
    if (r.enabled && (!p || !p.enabled)) flags.push({ code: 'routineAdded', routineId: r.id, cron: r.cron, action: r.action })
  }
  if (before) {
    for (const r of after.roles) {
      const p = prevRole.get(r.id)
      if (!p || p.instructions !== r.instructions) flags.push({ code: 'instructionsChanged', roleId: r.id })
    }
  }
  return flags
}

export function diffDefinitions(
  before: { files: readonly DefFile[]; def: TeamDefinition | null },
  after: { files: readonly DefFile[]; def: TeamDefinition | null },
): TeamDefinitionDiff {
  const files = diffTeamFiles(before.files, after.files)
  return { files, risks: after.def ? teamRiskFlags(before.def, after.def) : [], truncated: files.some((f) => f.truncated === true) }
}
