import { create } from 'zustand'
import type { GitError, GitInfoRes, GitSummary, GitUpdateEvt } from '@shared/git-types'

/**
 * Renderer mirror of main's git summaries, keyed by target (`ws:<id>`,
 * `pane:<id>`). Main emits only on change and every setter here is a no-op
 * when the value is the same, so subscribers (the phone snapshot) never fire
 * on a quiet poll.
 */
interface GitState {
  summaries: Record<string, GitSummary>
  errors: Record<string, GitError>
  info: GitInfoRes | null
  /** Changes panel target (E7-FR-11, rendered by the panel when it exists). */
  panel: { targetKey: string } | null
  apply: (evt: GitUpdateEvt) => void
  /** Forget keys that are no longer targets. */
  retain: (keys: ReadonlySet<string>) => void
  loadInfo: (force?: boolean) => Promise<void>
  openChanges: (targetKey: string) => void
  closeChanges: () => void
}

export const useGitStore = create<GitState>((set, get) => ({
  summaries: {},
  errors: {},
  info: null,
  panel: null,
  apply: (evt) => {
    const { summaries, errors } = get()
    if (evt.summary) {
      const prev = summaries[evt.key]
      if (prev && JSON.stringify(prev) === JSON.stringify(evt.summary) && !errors[evt.key]) return
      const nextErrors = { ...errors }
      delete nextErrors[evt.key]
      set({ summaries: { ...summaries, [evt.key]: evt.summary }, errors: nextErrors })
    } else {
      if (!(evt.key in summaries) && errors[evt.key] === evt.error) return
      const nextSummaries = { ...summaries }
      delete nextSummaries[evt.key]
      const nextErrors = { ...errors }
      if (evt.error) nextErrors[evt.key] = evt.error
      else delete nextErrors[evt.key]
      set({ summaries: nextSummaries, errors: nextErrors })
    }
  },
  retain: (keys) => {
    const { summaries, errors, panel } = get()
    const stale = Object.keys(summaries).concat(Object.keys(errors)).filter((k) => !keys.has(k))
    const panelGone = panel != null && !keys.has(panel.targetKey)
    if (!stale.length && !panelGone) return
    const s = { ...summaries }
    const e = { ...errors }
    for (const k of stale) {
      delete s[k]
      delete e[k]
    }
    set({ summaries: s, errors: e, ...(panelGone ? { panel: null } : {}) })
  },
  loadInfo: async (force) => {
    try {
      set({ info: await window.snApi.git.info(force) })
    } catch {
      set({ info: { available: false } })
    }
  },
  openChanges: (targetKey) => set({ panel: { targetKey } }),
  closeChanges: () => set({ panel: null }),
}))
