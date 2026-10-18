/**
 * Renderer side of agent resume (E5 G2): a mirror of main's session views
 * plus the transient pieces the renderer owns (one-shot launch intents, the
 * stack of closed consoles, the resume chips). A separate zustand store, never
 * persisted, so none of it reaches persist.ts or config.json.
 *
 * Must not import the app store: store.ts imports this file (closePane).
 */
import { create } from 'zustand'
import type { AgentSessionView, AgentsChangedEvt, AgentsStartup } from '@shared/agents'
import type { AgentProvider, Pane } from '@shared/types'

/** Closed consoles kept for "Reopen closed console" (E5-FR-14). */
export const CLOSED_STACK_MAX = 10

export interface ClosedPaneEntry {
  workspaceId: string
  pane: Pane
  /** Index the pane had in layout.order. */
  orderIndex: number
}

/** Chip over a pane after a launch decision (E5-FR-08). */
export type ResumeChipState =
  | { kind: 'resumed'; provider: AgentProvider; updatedAt: number; shownAt: number }
  | { kind: 'unavailable'; shownAt: number }
  | { kind: 'failed'; shownAt: number }

export interface AgentState {
  /** paneId -> session view from main. */
  sessions: Record<string, AgentSessionView>
  startup: AgentsStartup | null
  /** paneId -> intent consumed by the next spawn of that pane. */
  launchIntent: Record<string, 'resume' | 'fresh'>
  closedStack: ClosedPaneEntry[]
  resumeChip: Record<string, ResumeChipState>
  /** True while the "resume interrupted chats?" dialog is open (E5-FR-12, later). */
  modalPending: boolean

  setSessions: (list: AgentSessionView[]) => void
  applyChanged: (evt: AgentsChangedEvt) => void
  setStartup: (startup: AgentsStartup) => void
  setIntent: (paneId: string, intent: 'resume' | 'fresh') => void
  /** Returns and clears the pane's intent. */
  takeIntent: (paneId: string) => 'resume' | 'fresh' | undefined
  pushClosed: (entry: ClosedPaneEntry) => void
  /** Pops the most recent closed console, or undefined. */
  popClosed: () => ClosedPaneEntry | undefined
  setChip: (paneId: string, chip: ResumeChipState | null) => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  sessions: {},
  startup: null,
  launchIntent: {},
  closedStack: [],
  resumeChip: {},
  modalPending: false,

  setSessions: (list) => set({ sessions: Object.fromEntries(list.map((v) => [v.paneId, v])) }),

  applyChanged: (evt) =>
    set((s) => {
      const sessions = { ...s.sessions }
      if ('removed' in evt) delete sessions[evt.paneId]
      else sessions[evt.paneId] = evt
      return { sessions }
    }),

  setStartup: (startup) => set({ startup }),

  setIntent: (paneId, intent) => set((s) => ({ launchIntent: { ...s.launchIntent, [paneId]: intent } })),

  takeIntent: (paneId) => {
    const intent = get().launchIntent[paneId]
    if (intent) {
      set((s) => {
        const launchIntent = { ...s.launchIntent }
        delete launchIntent[paneId]
        return { launchIntent }
      })
    }
    return intent
  },

  pushClosed: (entry) => set((s) => ({ closedStack: [...s.closedStack, entry].slice(-CLOSED_STACK_MAX) })),

  popClosed: () => {
    const stack = get().closedStack
    const last = stack[stack.length - 1]
    if (last) set({ closedStack: stack.slice(0, -1) })
    return last
  },

  setChip: (paneId, chip) =>
    set((s) => {
      if (!chip && !(paneId in s.resumeChip)) return {}
      const resumeChip = { ...s.resumeChip }
      if (chip) resumeChip[paneId] = chip
      else delete resumeChip[paneId]
      return { resumeChip }
    }),
}))
