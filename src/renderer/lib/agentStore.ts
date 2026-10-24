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

/**
 * A history session a new console resumes on its first spawn (E3-FR-39,
 * phone `createPane.resume`). The cwd comes from main's index.
 */
export interface ResumeTarget {
  provider: AgentProvider
  sessionId: string
  cwd: string
  /** The session's last activity (the "resumed" chip shows it). */
  updatedAt: number
}

/** The open "resume interrupted chats?" dialog (E5-FR-12). */
export interface ResumeModalState {
  /** Interrupted panes it lists, in workspace and layout order. */
  paneIds: string[]
  trigger: AgentsStartup['trigger']
  /** Epoch ms the dialog opened (its countdown starts here). */
  openedAt: number
}

/** A console main put to sleep (E5-FR-25): its pty is gone and the chat waits in its transcript. */
export interface SleepInfo {
  /** Epoch ms it went to sleep. */
  at: number
  /** Idle threshold that put it to sleep. */
  idleMinutes: number
}

/**
 * What the workspace area shows: the grid, the agents board over it (E5-FR-27)
 * or the Teams overlay (app 2.7.0, E10 B1; CONTRATOS R30-14). Every
 * `setView('grid')` exit closes either one.
 */
export type AgentsView = 'grid' | 'board' | 'teams'

export interface AgentState {
  /** paneId -> session view from main. */
  sessions: Record<string, AgentSessionView>
  startup: AgentsStartup | null
  /** paneId -> intent consumed by the next spawn of that pane. */
  launchIntent: Record<string, 'resume' | 'fresh'>
  closedStack: ClosedPaneEntry[]
  resumeChip: Record<string, ResumeChipState>
  /** True while the "resume interrupted chats?" dialog is open (E5-FR-12). */
  modalPending: boolean
  modal: ResumeModalState | null
  /** Panes the dialog holds back: they show a placeholder and do not spawn until it is decided. */
  gated: Record<string, true>
  /** paneId -> history session its first spawn resumes (E3-FR-39), consumed once. */
  resumeTarget: Record<string, ResumeTarget>
  /** Sleeping consoles (E5-FR-25). Transient: a restart of the app mounts them as usual. */
  sleeping: Record<string, SleepInfo>
  view: AgentsView

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
  /** Opens the dialog and gates its panes, or (null) closes it and releases them. */
  setModal: (modal: ResumeModalState | null) => void
  setResumeTarget: (paneId: string, target: ResumeTarget) => void
  /** Returns and clears the pane's resume target. */
  takeResumeTarget: (paneId: string) => ResumeTarget | undefined
  /** Marks a console asleep, or (null) awake again. */
  setSleeping: (paneId: string, info: SleepInfo | null) => void
  setView: (view: AgentsView) => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  sessions: {},
  startup: null,
  launchIntent: {},
  closedStack: [],
  resumeChip: {},
  modalPending: false,
  modal: null,
  gated: {},
  resumeTarget: {},
  sleeping: {},
  view: 'grid',

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

  setModal: (modal) =>
    set(
      modal
        ? { modal, modalPending: true, gated: Object.fromEntries(modal.paneIds.map((id) => [id, true as const])) }
        : { modal: null, modalPending: false, gated: {} },
    ),

  setResumeTarget: (paneId, target) => set((s) => ({ resumeTarget: { ...s.resumeTarget, [paneId]: target } })),

  takeResumeTarget: (paneId) => {
    const target = get().resumeTarget[paneId]
    if (target) {
      set((s) => {
        const resumeTarget = { ...s.resumeTarget }
        delete resumeTarget[paneId]
        return { resumeTarget }
      })
    }
    return target
  },

  setSleeping: (paneId, info) =>
    set((s) => {
      if (!info && !(paneId in s.sleeping)) return {}
      const sleeping = { ...s.sleeping }
      if (info) sleeping[paneId] = info
      else delete sleeping[paneId]
      return { sleeping }
    }),

  setView: (view) => set((s) => (s.view === view ? {} : { view })),
}))
