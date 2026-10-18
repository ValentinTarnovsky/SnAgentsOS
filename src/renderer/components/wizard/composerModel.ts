/**
 * Workspace composer model (E8-FR-08/09), pure so it is unit tested without a
 * DOM: folder suggestions, the default agent, the key map and the panes a
 * create builds.
 */
import type { AgentPreset, GridPreset, Workspace } from '@shared/types'
import { normalizeOpenPath } from '@shared/openPath'
import { enterIsNative, type WizardKeyEvent, type WizardKeyTarget } from './wizardKeys'

/** The composer's grid choices; every cell runs the same agent. */
export const COMPOSER_GRIDS: readonly GridPreset[] = [1, 2, 4]

/** Most folder suggestions shown under the input. */
export const SUGGESTIONS_MAX = 8

export function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * Folders to suggest for `query`: the cwd of every workspace, most recent
 * first (the newest workspace sits last in the list), one per folder, up to 8.
 * A typed query keeps the ones containing it (case-insensitive) and drops the
 * exact folder already typed.
 */
export function folderSuggestions(workspaces: readonly Pick<Workspace, 'cwd'>[], query: string, max = SUGGESTIONS_MAX): string[] {
  const q = query.trim().toLowerCase()
  const typed = normalizeOpenPath(query)
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = workspaces.length - 1; i >= 0 && out.length < max; i--) {
    const cwd = workspaces[i].cwd?.trim()
    if (!cwd) continue
    const key = normalizeOpenPath(cwd)
    if (seen.has(key)) continue
    seen.add(key)
    if (q && (key === typed || !cwd.toLowerCase().includes(q))) continue
    out.push(cwd)
  }
  return out
}

/**
 * The agent the composer preselects: the saved default when it still exists,
 * else the first `claude` preset, else the first preset ('' with none).
 */
export function resolveDefaultPreset(presets: readonly AgentPreset[], defaultId: string | undefined): string {
  if (defaultId && presets.some((p) => p.id === defaultId)) return defaultId
  return presets.find((p) => p.type === 'claude')?.id ?? presets[0]?.id ?? ''
}

/**
 * - 'create': Ctrl+Enter anywhere, or Enter in a text input or on the agent
 *   selector, with a folder.
 * - 'block': the same keys without a folder: swallowed, nothing created.
 * - null: not ours (a textarea newline, a button or select's own Enter).
 */
export type ComposerKeyAction = 'create' | 'block' | null

export function composerKeyAction(e: WizardKeyEvent, target: WizardKeyTarget | null, hasCwd: boolean): ComposerKeyAction {
  if (e.key !== 'Enter' || e.isComposing || e.altKey) return null
  const verdict: ComposerKeyAction = hasCwd ? 'create' : 'block'
  if (e.ctrlKey || e.metaKey) return verdict
  if (e.shiftKey) return null
  if (target?.getAttribute?.('data-composer-agent') != null) return verdict
  return enterIsNative(target) ? null : verdict
}

export interface ComposerPaneDraft {
  type: AgentPreset['type']
  presetId?: string
  title: string
  color: string
  icon: string
}

/** One pane per grid cell, all with `preset` (a shell when it is gone). */
export function composerPanes(preset: AgentPreset | undefined, grid: GridPreset): ComposerPaneDraft[] {
  const pane: ComposerPaneDraft = preset
    ? { type: preset.type, presetId: preset.id, title: preset.name, color: preset.color, icon: preset.icon }
    : { type: 'shell', title: 'Shell', color: '#6366f1', icon: 'terminal' }
  return Array.from({ length: grid }, () => ({ ...pane }))
}

/** Next agent in the selector for an arrow key (wraps), or null when the key is not an arrow. */
export function nextAgentIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (Math.max(current, -1) + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
