import { useEffect } from 'react'
import { useAppStore } from './store'
import { useAgentStore } from './agentStore'
import { ctrlDigit, eventToAccel, isEditableTarget, resolveKeymap, SKIP_IN_EDITABLE, type ActionId } from './keymap'
import { focusPane, getFocusedPane } from './focus'
import { redrawPane } from './redrawRegistry'
import { promptNav } from './shellMarksRegistry'
import { liveSidebarOrder } from './sidebarOrder'
import { reopenClosedConsole } from './agentLaunch'
import { revealPane } from './revealPane'
import { toast } from './toast'
import { translate } from '@/i18n'
import { toggleChangesPanel } from './changesPanel'
import { toggleSidePanel } from './sidePanels'
import { runDictateShortcut } from './dictation'
import { panelKeyOf } from './changes'
import { sharedOverlayActive } from './shareGuestStore'
import { focusWorkspaceConsole } from './focusWorkspace'
import { focusedChatConsole, togglePaneView } from './consoleChatStore'
import {
  advanceWaiting,
  navigablePanes,
  navInputFrom,
  stepPane,
  stillWaiting,
  visibleConsoles,
  waitingIds,
  type NavInput,
  type WaitingCursor,
} from './agentNav'

/**
 * Sidebar display order (the single helper the Sidebar renders too): manual
 * or Smart, frozen while the sidebar has the pointer or the focus (E5-FR-22).
 */
function displayOrder() {
  return liveSidebarOrder(useAppStore.getState(), useAgentStore.getState())
}

/** "Next waiting" walk shared by consecutive presses (E5-FR-17). */
let waitingCursor: WaitingCursor | null = null

/**
 * Reveal the next console that needs the user, in the order the palette's
 * "Waiting for you" shows (the shared rule, src/shared/attention.ts: needs and
 * open requests first, then unread done, longest waiting first); presses
 * within 5 s keep walking the same list. With nobody waiting, a toast
 * (announced by the stack's aria-live).
 */
export function goToNextWaiting(now = Date.now()): string | null {
  const app = useAppStore.getState()
  const input = (): NavInput => navInputFrom(useAppStore.getState(), useAgentStore.getState())
  // A frozen entry still counts while it needs the user or was only seen
  // (revealing a done one clears its unread flag, not its state).
  const step = advanceWaiting(waitingCursor, () => waitingIds(input()), (id) => stillWaiting(input(), id), now)
  waitingCursor = step.cursor
  if (!step.target) {
    toast.info(translate(app.settings.language, 'agents.nobodyWaiting'), { dedupeKey: 'next-waiting' })
    return null
  }
  revealPane(step.target)
  return step.target
}

/** Focus the next/previous console of the active workspace in grid order. */
function focusStep(dir: 1 | -1): void {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  if (!ws) return
  const ids = navigablePanes(ws, s.minimized[ws.id] ?? [])
  const current = getFocusedPane()
  const target = stepPane(ids, current && ids.includes(current) ? current : null, dir)
  if (target) revealPane(target)
}

/**
 * Whether Ctrl+1..9 must stay out of the way: turned off, inside a text field
 * (the palette handles its own Ctrl+1..6) or with a modal open.
 */
function ctrlDigitBlocked(e: KeyboardEvent): boolean {
  const s = useAppStore.getState()
  if (s.settings.agents?.ctrlDigitFocus === false) return true
  if (s.paletteOpen || s.settingsOpen || s.wizardOpen || s.globalPromptOpen || s.quickPopoverOpen || useAgentStore.getState().modalPending) return true
  return isEditableTarget(e)
}

/**
 * Keymap actions that target the focused LOCAL console or the active local
 * workspace. While the shared view covers the grid (app 2.4.0) they are
 * swallowed: they would act on a console the user cannot see.
 */
const PANE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  'newConsole',
  'globalPrompt',
  'maximizePane',
  'minimizePane',
  'redrawPane',
  'promptPrev',
  'promptNext',
  'focusNextPane',
  'focusPrevPane',
  'quickCommands',
  'toggleChanges',
  'toggleFiles',
  'toggleNotes',
  'dictate',
  'toggleConsoleChat',
])

/**
 * The console `toggleConsoleChat` (app 2.7.0, A7) switches: the focused agent
 * console on screen with Labs consoleChat on (focusedChatConsole), and nothing
 * over the grid (a modal, the Quick Commands popover, the agents board). Null
 * means the action does nothing and the key goes on as if unbound, except
 * over the shared view, where it is swallowed (PANE_ACTIONS).
 */
function consoleChatKeyTarget(): string | null {
  if (quickBlocked() || useAppStore.getState().quickPopoverOpen || useAgentStore.getState().view === 'board') return null
  return focusedChatConsole()
}

function runAction(id: ActionId): void {
  const s = useAppStore.getState()
  switch (id) {
    case 'palette':
      s.setPaletteOpen(!s.paletteOpen)
      break
    case 'openSettings':
      s.setSettingsOpen(true)
      break
    case 'newWorkspace':
      // Already open (composer or its Advanced wizard): keep that surface and its draft.
      if (!s.wizardOpen) s.setWizardOpen(true)
      break
    case 'toggleSidebar':
      s.toggleSidebar()
      break
    case 'newConsole':
      if (s.activeWorkspaceId) s.addPane(s.activeWorkspaceId)
      break
    case 'globalPrompt':
      if (s.activeWorkspaceId) s.setGlobalPromptOpen(true)
      break
    case 'maximizePane': {
      const ws = s.activeWorkspaceId
      const pane = getFocusedPane()
      if (ws && pane) s.toggleMaximize(ws, pane)
      break
    }
    case 'minimizePane': {
      const ws = s.activeWorkspaceId
      const pane = getFocusedPane()
      if (ws && pane) s.toggleMinimize(ws, pane)
      break
    }
    case 'redrawPane': {
      const pane = getFocusedPane()
      if (pane) redrawPane(pane)
      break
    }
    case 'promptPrev':
    case 'promptNext': {
      // E6-FR-27: the focused pane's prompt marks; without marks nothing moves.
      const pane = getFocusedPane()
      if (pane) promptNav(pane, id === 'promptPrev' ? -1 : 1)
      break
    }
    case 'workspaceFlip': {
      const prev = s.previousWorkspaceId
      if (prev && prev !== s.activeWorkspaceId && s.workspaces.some((w) => w.id === prev)) {
        s.setActive(prev)
      }
      break
    }
    case 'workspaceNext':
    case 'workspacePrev': {
      const list = displayOrder()
      if (list.length < 2) break
      const idx = list.findIndex((w) => w.id === s.activeWorkspaceId)
      const cur = idx < 0 ? 0 : idx
      const to =
        id === 'workspaceNext'
          ? (cur + 1) % list.length
          : (cur - 1 + list.length) % list.length
      s.setActive(list[to].id)
      break
    }
    case 'nextWaiting':
      goToNextWaiting()
      break
    case 'reopenClosedPane':
      reopenClosedConsole()
      break
    case 'focusNextPane':
      focusStep(1)
      break
    case 'focusPrevPane':
      focusStep(-1)
      break
    case 'quickCommands':
      // E8-FR-04: never over another modal (settings, wizard, palette, prompt).
      if (s.quickPopoverOpen) {
        // Closing with the shortcut gives the console its focus back, like Esc.
        s.setQuickPopoverOpen(false)
        const paneId = getFocusedPane()
        if (paneId) setTimeout(() => focusPane(paneId), 0)
      } else if (!quickBlocked()) s.setQuickPopoverOpen(true)
      break
    case 'toggleChanges':
      toggleChangesPanel()
      break
    case 'toggleFiles':
      toggleSidePanel('files')
      break
    case 'toggleNotes':
      toggleSidePanel('notes')
      break
    case 'dictate':
      runDictateShortcut()
      break
    case 'toggleConsoleChat': {
      const paneId = consoleChatKeyTarget()
      if (paneId) togglePaneView(paneId)
      break
    }
    case 'agentsBoard': {
      // E5-FR-27: never over a modal; the board closes itself on Esc or a pick.
      const agents = useAgentStore.getState()
      if (agents.view === 'board') agents.setView('grid')
      else if (!quickBlocked() && !s.quickPopoverOpen) agents.setView('board')
      break
    }
  }
}

/** A modal is open: the Quick Commands popover stays closed (E8-FR-04). */
export function quickBlocked(): boolean {
  const s = useAppStore.getState()
  return s.paletteOpen || s.settingsOpen || s.wizardOpen || s.globalPromptOpen || useAgentStore.getState().modalPending
}

/**
 * Central keyboard dispatcher (S13). Resolves each keydown against the active
 * keymap (defaults + user overrides) and runs the matching action. Attached on
 * the capture phase so it wins over xterm. Alt+1..9 (jump to Nth workspace) and
 * Ctrl+1..9 (focus the Nth visible console of the active workspace) are fixed
 * numeric families, not part of the remappable keymap.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The resume dialog (E5-FR-12) owns the keyboard until it is decided.
      if (useAgentStore.getState().modalPending) return
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const target = displayOrder()[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          e.stopPropagation()
          // Over the shared view (app 2.4.0) the active workspace itself is a way back:
          // the focus request makes the overlay guard leave even when the id does not change.
          const back = sharedOverlayActive()
          useAppStore.getState().setActive(target.id)
          if (back) focusWorkspaceConsole(target.id)
        }
        return
      }

      // The shared view (app 2.4.0) covers the local grid: Ctrl+1..9 would
      // focus a hidden local console, so it is left to the shared terminal.
      const overlay = sharedOverlayActive()
      const digit = ctrlDigit(e)
      if (digit !== null && !overlay && !ctrlDigitBlocked(e)) {
        const s = useAppStore.getState()
        const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
        const target = ws ? visibleConsoles(ws, s.minimized[ws.id] ?? [], s.maximized[ws.id])[digit - 1] : undefined
        if (target) {
          e.preventDefault()
          e.stopPropagation()
          revealPane(target)
          return
        }
      }
      // A Ctrl+digit left unhandled falls through to a user binding, if any;
      // otherwise Ctrl+3..8 reach xterm as control bytes (Ctrl+3 = ESC).

      const accel = eventToAccel(e)
      if (!accel) return
      // Inside the Changes panel its own keys (F7, Alt+arrows, Alt+Z, Esc) win over any binding (E7-FR-14).
      if (panelKeyOf(e) && (e.target as Element | null)?.closest?.('[data-changes-panel]')) return
      const keymap = resolveKeymap(useAppStore.getState().settings.keymap)
      for (const id of Object.keys(keymap) as ActionId[]) {
        if (keymap[id] === accel) {
          // Ctrl+Shift+U inside a text field stays the field's key.
          if (SKIP_IN_EDITABLE.has(id) && isEditableTarget(e)) return
          // Lab off or no agent console focused: the user's chord is not eaten (another binding or the console gets it).
          // Over the shared view it is swallowed like every pane action, never left to the shared terminal.
          if (id === 'toggleConsoleChat' && !overlay && !consoleChatKeyTarget()) continue
          e.preventDefault()
          e.stopPropagation()
          if (overlay && PANE_ACTIONS.has(id)) return
          runAction(id)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
