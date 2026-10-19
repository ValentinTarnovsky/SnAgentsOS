/**
 * The live phase's screen stack (E2-FR-01, 13, 16). Home is always mounted
 * underneath. The terminal is a layer that slides in over it with the 300ms
 * push of E1/M5 and, when Home is on top, stays mounted off screen with
 * translateX(100%) (not display:none), so the xterm keeps its size and its
 * buffer and coming back to the same console is instant. Settings is a
 * PushScreen over Home; Diagnostics (E2-FR-36) is one over whatever is on top,
 * so the header dots, the banner and Settings all reach it; History
 * (E3-FR-36) is one too, from a workspace's menu or the terminal's kebab. Each pushed
 * screen holds a back claim, so the Android back gesture, the chevron and
 * history.back() all return to Home. Changes (E3-FR-52) is one too, from a
 * workspace's git chip or the terminal's kebab, with a file's diff pushed over
 * it and the notes sheets above both. Automations (E8-FR-32, v3.1) is one too,
 * from the Home header or Settings. The mount confirmation (E2-FR-06) is
 * shared by every entry point.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { HomeScreen } from './HomeScreen'
import { MainScreen } from './MainScreen'
import { SettingsScreen } from './SettingsScreen'
import { DiagnosticsScreen } from './DiagnosticsScreen'
import { HistoryScreen } from './HistoryScreen'
import { AutomationsScreen } from './AutomationsScreen'
import { ChangesScreen } from './changes/ChangesScreen'
import { DiffScreen } from './changes/DiffScreen'
import { NotesList } from './changes/NotesList'
import { SendNotesSheet } from './changes/SendNotesSheet'
import { MountConfirmSheet } from './MountConfirmSheet'
import { SLIDE_EASING, SLIDE_MS } from './PushScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { BackStackHost, useBackClaim } from '../lib/useBackClaim'
import { prefersReducedMotion } from '../lib/sheetDrag'

/** The terminal layer: on screen while `open`, parked at translateX(100%) otherwise. */
function TerminalLayer({ open }: { open: boolean }): ReactNode {
  const { requestClose } = useBackClaim(open, () => client.leaveTerminal())
  const ref = useRef<HTMLDivElement | null>(null)
  // Off screen only after the slide out ends, so the content is never hidden mid-slide.
  const [parked, setParked] = useState(!open)
  const reduced = prefersReducedMotion()

  useLayoutEffect(() => {
    if (open) setParked(false)
  }, [open])

  useEffect(() => {
    if (open) return
    // Leaving: drop the focus so the soft keyboard does not stay up over Home.
    const el = ref.current
    if (el && document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur()
    if (reduced) {
      setParked(true)
      return
    }
    const timer = setTimeout(() => setParked(true), SLIDE_MS + 50)
    return () => clearTimeout(timer)
  }, [open, reduced])

  return (
    <div
      ref={ref}
      data-terminal-layer
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      className="fixed inset-x-0 top-0 z-30 bg-bg-primary"
      style={{
        height: 'var(--vvh, 100dvh)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: reduced ? 'none' : `transform ${SLIDE_MS}ms ${SLIDE_EASING}`,
        visibility: parked && !open ? 'hidden' : 'visible',
      }}
    >
      <MainScreen onBack={requestClose} />
    </div>
  )
}

export function LiveShell(): ReactNode {
  const screen = useRemoteStore((s) => s.screen)
  const setScreen = useRemoteStore((s) => s.setScreen)
  return (
    <BackStackHost>
      <HomeScreen />
      <TerminalLayer open={screen === 'terminal'} />
      <SettingsScreen open={screen === 'settings'} onClose={() => setScreen('home')} />
      <MountConfirmSheet />
      <HistoryScreen />
      <AutomationsScreen />
      <ChangesScreen />
      <DiffScreen />
      <NotesList />
      <SendNotesSheet />
      <DiagnosticsScreen />
    </BackStackHost>
  )
}
