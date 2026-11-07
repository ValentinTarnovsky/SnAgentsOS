/**
 * Hands-free voice (app 2.11.0): the names a user says for workspaces and
 * consoles, and resolving what Whisper heard against them. Pure: the renderer
 * hands in the workspaces in sidebar order and each console's display title
 * (agentTitle) in grid order; main re-checks every id it gets back.
 */
import { editDistance, foldSpeech, numberOf, soundFold } from './voiceCommands'
import { VOICE_LABEL_MAX, type VoiceRoster } from './voice'

export interface SpokenInput {
  workspaces: Array<{
    id: string
    name: string
    panes: Array<{ id: string; title: string; defaultTitle: boolean }>
  }>
}

function oneLine(s: string): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VOICE_LABEL_MAX)
}

/**
 * Labels to say: a workspace by its name; a renamed console by its title; a
 * default-named one by its workspace's name when it is the only console, else
 * "<workspace> <n>" (its 1-based grid position). A console label that two
 * workspaces share gets its workspace's name in front.
 */
export function spokenLabels(input: SpokenInput): VoiceRoster {
  const roster: VoiceRoster = {
    workspaces: input.workspaces.map((ws) => {
      const wsLabel = oneLine(ws.name) || ws.id
      return {
        id: ws.id,
        label: wsLabel,
        panes: ws.panes.map((p, i) => ({
          id: p.id,
          label: oneLine(!p.defaultTitle && p.title ? p.title : ws.panes.length === 1 ? wsLabel : `${wsLabel} ${i + 1}`) || `${wsLabel} ${i + 1}`,
        })),
      }
    }),
  }
  const owners = new Map<string, Set<string>>()
  for (const ws of roster.workspaces) {
    for (const p of ws.panes) {
      const key = foldSpeech(p.label)
      const set = owners.get(key) ?? new Set<string>()
      set.add(ws.id)
      owners.set(key, set)
    }
  }
  for (const ws of roster.workspaces) {
    for (const p of ws.panes) {
      if ((owners.get(foldSpeech(p.label))?.size ?? 0) > 1 && !foldSpeech(p.label).startsWith(foldSpeech(ws.label))) p.label = oneLine(`${ws.label} ${p.label}`)
    }
  }
  return roster
}

export type SpokenTarget = { kind: 'console'; id: string; workspaceId: string; label: string } | { kind: 'workspace'; id: string; label: string }

export type SpokenResolution = { ok: true; target: SpokenTarget } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'ambiguous'; options: SpokenTarget[] }

/** How alike two folded names sound, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = soundFold(a)
  const y = soundFold(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const d = editDistance(x, y)
  return Math.max(0, 1 - d / Math.max(x.length, y.length))
}

const ACCEPT = 0.8
const MARGIN = 0.1
const MAYBE = 0.6

function score(ref: string, label: string): number {
  const r = foldSpeech(ref)
  const l = foldSpeech(label)
  if (!r || !l) return 0
  if (r === l) return 1.01
  let best = nameSimilarity(r, l)
  // A word of the label said alone ("pagos" for "Consola pagos"), or the label said without its workspace prefix.
  const words = l.split(' ')
  if (words.some((w) => w.length >= 3 && soundFold(w) === soundFold(r))) best = Math.max(best, 0.9)
  if (r.split(' ').length < words.length) {
    for (let k = 1; k < words.length; k++) best = Math.max(best, nameSimilarity(r, words.slice(k).join(' ')) - 0.02)
  }
  return best
}

function pick(ref: string, candidates: SpokenTarget[]): SpokenResolution {
  const scored = candidates.map((c) => ({ c, s: score(ref, c.label) })).sort((a, b) => b.s - a.s)
  const [first, second] = scored
  if (!first || first.s < MAYBE) return { ok: false, reason: 'not_found' }
  if (first.s >= ACCEPT && (!second || first.s - second.s >= MARGIN)) return { ok: true, target: first.c }
  return { ok: false, reason: 'ambiguous', options: scored.filter((x) => x.s >= MAYBE).slice(0, 2).map((x) => x.c) }
}

function consolesOf(roster: VoiceRoster, wsId?: string | null): SpokenTarget[] {
  return roster.workspaces
    .filter((ws) => !wsId || ws.id === wsId)
    .flatMap((ws) => ws.panes.map((p) => ({ kind: 'console' as const, id: p.id, workspaceId: ws.id, label: p.label })))
}

function workspacesOf(roster: VoiceRoster): SpokenTarget[] {
  return roster.workspaces.map((ws) => ({ kind: 'workspace' as const, id: ws.id, label: ws.label }))
}

/**
 * What the user named. `want`: 'console', 'workspace' or 'any' (a console of
 * the active workspace first, then any workspace, then any console). A number
 * is a position: the Nth console of the active workspace, or the Nth
 * workspace in sidebar order. "<workspace> <n>" is that workspace's Nth console.
 */
export function resolveSpokenRef(ref: string, roster: VoiceRoster, activeWorkspaceId: string | null, want: 'console' | 'workspace' | 'any'): SpokenResolution {
  const r = foldSpeech(ref)
  if (!r) return { ok: false, reason: 'not_found' }
  const words = r.split(' ')
  const active = roster.workspaces.find((w) => w.id === activeWorkspaceId) ?? null
  // A bare number.
  if (words.length === 1 && numberOf(words[0]) !== null) {
    const n = numberOf(words[0]) as number
    if (want === 'workspace') {
      const ws = roster.workspaces[n - 1]
      return ws ? { ok: true, target: { kind: 'workspace', id: ws.id, label: ws.label } } : { ok: false, reason: 'not_found' }
    }
    const p = active?.panes[n - 1]
    return p && active ? { ok: true, target: { kind: 'console', id: p.id, workspaceId: active.id, label: p.label } } : { ok: false, reason: 'not_found' }
  }
  // "<workspace> <n>".
  const lastN = numberOf(words[words.length - 1])
  if (want !== 'workspace' && words.length >= 2 && lastN !== null) {
    const wsRes = pick(words.slice(0, -1).join(' '), workspacesOf(roster))
    if (wsRes.ok) {
      const ws = roster.workspaces.find((w) => w.id === wsRes.target.id)
      const p = ws?.panes[lastN - 1]
      if (ws && p) return { ok: true, target: { kind: 'console', id: p.id, workspaceId: ws.id, label: p.label } }
    }
  }
  if (want === 'workspace') return pick(r, workspacesOf(roster))
  if (want === 'console') {
    const local = active ? pick(r, consolesOf(roster, active.id)) : null
    if (local?.ok) return local
    return pick(r, consolesOf(roster))
  }
  const local = active ? pick(r, consolesOf(roster, active.id)) : null
  if (local?.ok) return local
  const ws = pick(r, workspacesOf(roster))
  if (ws.ok) return ws
  const any = pick(r, consolesOf(roster))
  if (any.ok) return any
  if (ws.reason === 'ambiguous' || any.reason === 'ambiguous' || local?.reason === 'ambiguous') {
    const options = [...(local && !local.ok && local.reason === 'ambiguous' ? local.options : []), ...(!ws.ok && ws.reason === 'ambiguous' ? ws.options : []), ...(!any.ok && any.reason === 'ambiguous' ? any.options : [])]
    return { ok: false, reason: 'ambiguous', options: options.slice(0, 2) }
  }
  return { ok: false, reason: 'not_found' }
}

/** The answer to "API o API Gateway?": a name, or "la primera" / "la segunda". */
export function pickOption(heard: string, options: SpokenTarget[]): SpokenTarget | null {
  const r = foldSpeech(heard).split(' ').filter((w) => w !== 'la' && w !== 'el' && w !== 'the' && w !== 'one')
  if (r.length === 1) {
    const n = numberOf(r[0])
    if (n !== null && n >= 1 && n <= options.length) return options[n - 1]
  }
  const res = pick(r.join(' '), options)
  return res.ok ? res.target : null
}
