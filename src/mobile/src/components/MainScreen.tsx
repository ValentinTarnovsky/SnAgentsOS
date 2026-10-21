/**
 * The terminal screen (E2-FR-16), stacked over Home by LiveShell: a flex
 * column sized to the keyboard-aware --vvh so the KeyBar always docks just
 * above the soft keyboard. Header: a back chevron (to Home), the viewed
 * console's title with its agent status and its workspace as the meta line
 * (the viewed pane's own workspace, E2-FR-47; after it the console's `snaos
 * status` line, else the workspace note: E8-FR-19/11, v3.1), the phone mode chip (E3-FR-13),
 * the "N waiting" pill and a kebab with the console's actions plus Quick Commands (E2-FR-08/16/51).
 * The kebab's first extra row is "Model and effort" of a Claude or Codex
 * console (AgentTuneSheet, hint "opus · high · UC"), only with a desktop
 * >= 2.3.0; app 2.4.0 moved it there from a header chip that crowded the title.
 * Below: pane tabs of that workspace (E1-FR-32), the terminal (flex-1,
 * min-h-0), the answer card or the "waiting" strip (E2-FR-17..25), the
 * composer or "Direct input" strip (E1-FR-22..31, 38) and the KeyBar. The status banner and the toasts overlay the terminal.
 * Chat view (E3 M12): the [Terminal | Chat] control sits in the header; in
 * Chat the transcript covers the paused terminal (kept mounted, hidden), the
 * composer is always docked (FR-31) and the KeyBar steps aside.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronLeft, GitCompare, History, MoreVertical, SlidersHorizontal, Zap } from 'lucide-react'
import { RemoteTerminal } from './RemoteTerminal'
import { KeyBar } from './KeyBar'
import { PaneTabs } from './PaneTabs'
import { PaneActionList } from './PaneActionList'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { AgentTuneSheet, useTuneTarget } from './AgentTuneSheet'
import { Composer, toggleInputMode } from './Composer'
import { pasteKey } from './pasteKey'
import { DirectInputStrip } from './DirectInputStrip'
import { ExitStrip } from './ExitStrip'
import { PromptCard } from './prompts/PromptCard'
import { AgentEndStrip } from './AgentEndStrip'
import { DOT_COLOR, StatusBanner, useConnectionHealth } from './StatusBanner'
import { openDiagnostics } from '../lib/connLog'
import { openHistory } from '../lib/history'
import { openChanges } from '../lib/changes'
import { tuneSummary } from '../lib/tune'
import { StatusIndicator } from './StatusIndicator'
import { CacheChip } from './CacheChip'
import { WaitingPill } from './WaitingPill'
import { FitModeChip } from './FitModeChip'
import { ToastStack } from './ToastStack'
import { UploadChip } from './UploadChip'
import { ChatView } from './chat/ChatView'
import { ViewToggle } from './chat/ViewToggle'
import { selectInChat, selectInputMode, store, useRemoteStore } from '../lib/store'
import { paneById, viewedWorkspaceId, type PaneRef } from '../lib/workspace'
import { t } from '../lib/i18n'

/** Header dot colored by the connection tier (E1-FR-13); off 'ok' a tap opens Diagnostics (E2-FR-36). */
function ConnectionDot(): ReactNode {
  const { tier } = useConnectionHealth()
  const dot = <span data-tier={tier} className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', DOT_COLOR[tier])} />
  if (tier === 'ok') return dot
  return (
    <button
      type="button"
      data-action="dot-diagnostics"
      onClick={openDiagnostics}
      aria-label={t('diag.open')}
      className="-m-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full active:bg-card"
    >
      {dot}
    </button>
  )
}

export function MainScreen({ onBack }: { onBack?: () => void } = {}): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  const activeStatus = useRemoteStore((s) => (s.activePaneId ? s.paneStatus[s.activePaneId] : undefined))
  const connected = useRemoteStore((s) => s.connected)
  const inputMode = useRemoteStore(selectInputMode)
  const kbOpen = useRemoteStore((s) => s.kbOpen)
  const inChat = useRemoteStore(selectInChat)
  const [quickOpen, setQuickOpen] = useState(false)
  const [paneActions, setPaneActions] = useState<PaneRef | null>(null)
  const [kebab, setKebab] = useState<PaneRef | null>(null)
  const [tuneOpen, setTuneOpen] = useState(false)
  const tuneTarget = useTuneTarget(activePaneId)

  // A Paste one-shot belongs to the pane it was opened on: leaving it ends it.
  useEffect(() => {
    const s = store.getState()
    if (s.composerOneShot && s.composerOneShot !== activePaneId) s.update({ composerOneShot: null })
  }, [activePaneId])

  const { workspaceId, workspaceName, paneTitle, statusLine, note } = useMemo(() => {
    if (!snapshot) return { workspaceId: null, workspaceName: '', paneTitle: t('main.noConsole'), statusLine: undefined, note: undefined }
    // The viewed pane's own workspace (E2-FR-47), never the desktop's.
    const wsId = viewedWorkspaceId(snapshot, activePaneId)
    const ws = snapshot.workspaces.find((w) => w.id === wsId)
    const pane = paneById(snapshot, activePaneId)
    return {
      workspaceId: ws?.id ?? null,
      workspaceName: ws?.name ?? '',
      paneTitle: pane?.title ?? t('main.noConsole'),
      statusLine: pane?.statusLine,
      note: ws?.note,
    }
  }, [snapshot, activePaneId])

  return (
    <div data-terminal-screen className="flex flex-col overflow-hidden bg-bg-primary" style={{ height: 'var(--vvh, 100dvh)' }}>
      <header
        className="flex shrink-0 items-center gap-1.5 border-b border-border bg-bg-secondary py-1.5 pl-1 pr-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 6px)' }}
      >
        {onBack && (
          <button
            data-terminal-back
            onClick={onBack}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
            aria-label={t('nav.back')}
          >
            <ChevronLeft size={22} />
          </button>
        )}
        <ConnectionDot />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span data-pane-title className="truncate text-sm font-semibold leading-tight text-text-primary">{paneTitle}</span>
            <StatusIndicator status={activeStatus} />
            {activePaneId && <CacheChip paneId={activePaneId} />}
          </div>
          {workspaceName && (
            <div className="flex min-w-0 text-[11px] leading-tight text-text-secondary">
              <span data-ws-name className={clsx('truncate', (statusLine || note) && 'max-w-[45%] shrink-0')}>{workspaceName}</span>
              {statusLine ? (
                <span data-pane-statusline title={statusLine} className="min-w-0 truncate text-text-primary/80">
                  {' · '}
                  {statusLine}
                </span>
              ) : (
                note && (
                  <span data-ws-note title={note} className="min-w-0 truncate">
                    {' · '}
                    {note}
                  </span>
                )
              )}
            </div>
          )}
        </div>
        <ViewToggle />
        <FitModeChip />
        <WaitingPill />
        <button
          data-terminal-kebab
          onClick={() => {
            if (workspaceId && activePaneId) setKebab({ workspaceId, paneId: activePaneId })
            else setQuickOpen(true)
          }}
          className="flex h-10 w-10 items-center justify-center rounded-btn text-text-secondary active:bg-card"
          aria-label={t('act.more')}
        >
          <MoreVertical size={20} />
        </button>
      </header>

      <PaneTabs onPaneActions={setPaneActions} />

      <main className="relative min-h-0 flex-1">
        {/* The terminal stays mounted under the Chat view (its stream is paused, FR-25). */}
        <div className={clsx('h-full w-full', inChat && 'invisible')} aria-hidden={inChat || undefined}>
          <RemoteTerminal />
        </div>
        {inChat && activePaneId && <ChatView paneId={activePaneId} />}
        <StatusBanner />
        <ToastStack />
      </main>

      <ExitStrip />
      <AgentEndStrip />

      {/* Answer cards for the viewed console (E2-FR-17..25). */}
      <PromptCard />

      {/* Image upload progress / retry / copy path (E3-FR-08). */}
      <UploadChip />
      {/* Composer mode docks the composer here; Direct mode shows the strip
          only while the keyboard is down (E1-FR-38). Both stay usable offline:
          the draft is kept and Send is disabled (E1-FR-14). */}
      {activePaneId && (inChat || inputMode === 'composer' ? <Composer /> : !kbOpen && <DirectInputStrip />)}

      {/* Offline: the keys are dimmed and inert (E1-FR-14); sendInput refuses too.
          In Chat there is no terminal to type keys into: the composer is the input. */}
      <div
        hidden={inChat}
        className={clsx('shrink-0 transition-opacity', !connected && 'pointer-events-none opacity-40')}
        aria-disabled={!connected}
        data-connected={connected}
      >
        <KeyBar
          onPaste={pasteKey}
          onQuickCommands={() => setQuickOpen(true)}
          inputMode={inputMode}
          onToggleMode={activePaneId ? toggleInputMode : undefined}
        />
      </div>

      <QuickCommandsSheet open={quickOpen} onClose={() => setQuickOpen(false)} />
      <AgentTuneSheet paneId={activePaneId} open={tuneOpen} onClose={() => setTuneOpen(false)} />
      <PaneActionList target={paneActions} onClose={() => setPaneActions(null)} />
      <PaneActionList
        target={kebab}
        onClose={() => setKebab(null)}
        extraItems={[
          ...(tuneTarget && kebab?.paneId === tuneTarget.paneId
            ? [
                {
                  // App 2.3.0: model, effort and Ultracode of this console. App 2.4.0: the
                  // first extra row, its hint is what the console runs (the old header chip).
                  id: 'tune',
                  icon: <SlidersHorizontal size={16} />,
                  label: t('tune.title'),
                  hint: tuneSummary(activeStatus) ?? undefined,
                  onSelect: () => {
                    setKebab(null)
                    setTuneOpen(true)
                  },
                },
              ]
            : []),
          {
            id: 'quick',
            icon: <Zap size={16} />,
            label: t('quick.title'),
            onSelect: () => {
              setKebab(null)
              setQuickOpen(true)
            },
          },
          {
            // E3-FR-36: the session history of the viewed console's workspace.
            id: 'history',
            icon: <History size={16} />,
            label: t('history.open'),
            onSelect: () => {
              const wsId = kebab?.workspaceId
              setKebab(null)
              if (wsId) openHistory(wsId)
            },
          },
          {
            // E3-FR-52: the change list of the viewed console's workspace.
            id: 'changes',
            icon: <GitCompare size={16} />,
            label: t('changes.open'),
            onSelect: () => {
              const wsId = kebab?.workspaceId
              setKebab(null)
              if (wsId) openChanges(wsId)
            },
          },
        ]}
      />
    </div>
  )
}
