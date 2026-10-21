import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { initUpdaterEvents, startUpdateScheduler } from '@/lib/updater'
import { checkUpdateNotApplied } from '@/lib/updateNotApplied'
import { initUsageEvents, syncUsageConfig } from '@/lib/usageStore'
import { initAccountsEvents, syncAccountsConfig } from '@/lib/accountsStore'
import { initRemoteEvents, syncRemoteConfig } from '@/lib/remoteStore'
import { initShareHostEvents, syncShareHostConfig } from '@/lib/shareHostStore'
import { initRemoteCommands } from '@/lib/remoteCommands'
import { initPromptResults } from '@/lib/promptDelivery'
import { initLegacyEvents } from '@/lib/legacyStore'
import { initPowerEvents, syncAgentSettings, syncAwakeMode } from '@/lib/powerStore'
import { startRemoteSnapshotSync } from '@/lib/remoteSnapshot'
import { startGitSync } from '@/lib/gitSync'
import { startReviewNotesSync } from '@/lib/reviewNotesStore'
import { startWsNotesSync } from '@/lib/wsNotesSync'
import { initShareGuest } from '@/lib/shareGuestStore'
import { engineFromSettings } from '@shared/terminalEngine'
import { mountInterruptedAgents } from '@/lib/agentLaunch'
import { initHibernation } from '@/lib/hibernation'
import { startPersistence } from '@/lib/persist'
import { initPtyLifecycle, reconcilePtys } from '@/lib/ptyLifecycle'
import { initOpenRequests } from '@/lib/openRequest'
import { useGlobalKeys } from '@/lib/useGlobalKeys'
import { showRecoveryCard } from '@/lib/renderErrors'
import { AppErrorBoundary, TitleBarBoundary } from '@/components/common/ErrorBoundary'
import { usePaneScheduler } from '@/lib/usePaneScheduler'
import { useStatusEvents } from '@/lib/useStatusEvents'
import { applyTheme } from '@/themes'
import { I18nProvider, useT } from '@/i18n'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { WorkspaceHost } from '@/components/layout/WorkspaceHost'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { ReleaseNotesModal } from '@/components/updates/ReleaseNotesModal'
import { UpdateCardHost } from '@/components/updates/UpdateCard'
import { RebrandNotice } from '@/components/rebrand/RebrandNotice'
import { LegacyBanner } from '@/components/rebrand/LegacyBanner'
import { RemoteQrModal } from '@/components/remote/RemoteQrModal'
import { RemotePairingPrompt } from '@/components/remote/RemotePairingPrompt'
import { ShareDialog } from '@/components/share/ShareDialog'
import { ShareJoinPrompt } from '@/components/share/ShareJoinPrompt'
import { NewWorkspaceWizard } from '@/components/wizard/NewWorkspaceWizard'
import { WorkspaceComposer } from '@/components/wizard/WorkspaceComposer'
import { TrustDialog } from '@/components/ui/TrustDialog'
import { ExportRepoConfigDialog } from '@/components/ui/ExportRepoConfigDialog'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { CommandPalette } from '@/components/ui/CommandPalette'
import { GlobalPromptDialog } from '@/components/workspace/GlobalPromptDialog'
import { WorktreeLaunchDialog } from '@/components/workspace/WorktreeLaunchDialog'
import { WorktreeCloseDialog } from '@/components/layout/WorktreeCloseDialog'
import { QuickCommandPopover } from '@/components/workspace/QuickCommandPopover'
import { NotificationStack } from '@/components/ui/NotificationStack'
import { ResumeDialog } from '@/components/agents/ResumeDialog'
import { AgentsBoard } from '@/components/agents/AgentsBoard'
import { SharedWorkspaceHost } from '@/components/share/SharedWorkspaceHost'
import { JoinShareDialog } from '@/components/share/JoinShareDialog'
import { ConfirmLinkDialog } from '@/components/share/ConfirmLinkDialog'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

export function App() {
  const hydrated = useAppStore((s) => s.hydrated)
  const cliEnabled = useAppStore((s) => s.settings.cliEnabled !== false)
  const hydrate = useAppStore((s) => s.hydrate)
  const theme = useAppStore((s) => s.settings.theme)
  const customColors = useAppStore((s) => s.settings.customColors)
  const language = useAppStore((s) => s.settings.language)
  const usage = useAppStore((s) => s.settings.usage)
  const claudeAccounts = useAppStore((s) => s.settings.claudeAccounts)
  const remote = useAppStore((s) => s.settings.remote)
  const shareEnabled = useAppStore((s) => s.settings.share.enabled)
  const sharePort = useAppStore((s) => s.settings.share.port)
  const awakeMode = useAppStore((s) => s.settings.awakeMode)
  const agents = useAppStore((s) => s.settings.agents)
  const snapshotMode = useAppStore((s) => s.settings.terminalSnapshotMode)
  const unicode11 = useAppStore((s) => s.settings.terminalUnicode11)
  const persistScrollback = useAppStore((s) => s.settings.persistScrollback)
  const persistScrollbackLines = useAppStore((s) => s.settings.persistScrollbackLines)
  const shellIntegration = useAppStore((s) => s.settings.terminalShellIntegration)

  // Load persisted config once, then start the debounced persistence writer.
  // The pty lifecycle (E4-FR-36) starts right after hydrate: removed panes are
  // killed from then on, and main kills the ptys whose pane did not survive
  // the reload. A failed load never reconciles (an empty store is not "no panes").
  useEffect(() => {
    let unsub: (() => void) | undefined
    let stopLifecycle: (() => void) | undefined
    let stopNotes: (() => void) | undefined
    let stopWsNotes: (() => void) | undefined
    window.snApi.config
      .load()
      .then((cfg) => {
        hydrate(cfg)
        stopLifecycle = initPtyLifecycle()
        // Review notes (E7-FR-18): prune those of deleted workspaces only after a real load.
        stopNotes = startReviewNotesSync({ prune: cfg != null })
        // Workspace notes (v2.2): never against a store that failed to load (it would look empty).
        if (cfg) stopWsNotes = startWsNotesSync({ prune: true })
        // The recovery card (E4-FR-22) counts consoles after the reconcile.
        void (cfg ? reconcilePtys() : Promise.resolve(0)).then(() => showRecoveryCard())
        unsub = startPersistence()
      })
      .catch(() => {
        hydrate(null)
        stopLifecycle = initPtyLifecycle()
        stopNotes = startReviewNotesSync({ prune: false })
        void showRecoveryCard()
      })
    return () => {
      unsub?.()
      stopLifecycle?.()
      stopNotes?.()
      stopWsNotes?.()
    }
  }, [hydrate])

  // Apply the active theme to CSS custom properties (xterm reads it separately).
  useEffect(() => {
    applyTheme(theme, customColors)
  }, [theme, customColors])

  // Keep the download-progress stream wired for the whole app lifetime.
  useEffect(() => initUpdaterEvents(), [])

  // Keep the usage-snapshot stream wired for the whole app lifetime.
  useEffect(() => initUsageEvents(), [])

  // Claude accounts (app 2.3.0): main's state and event streams for the whole app lifetime.
  useEffect(() => initAccountsEvents(), [])

  // Keep the remote server-status stream + control-command handler wired.
  useEffect(() => initRemoteEvents(), [])
  useEffect(() => initRemoteCommands(), [])
  // Share host (app 2.4.0, item 8): main's grants, guests and join requests for the whole app lifetime.
  useEffect(() => initShareHostEvents(), [])
  // Initial prompt outcomes (E8-FR-02b): toasts for the unconfirmed or undelivered ones.
  useEffect(() => initPromptResults(), [])

  // Shared with me (app 2.4.0, item 8): main's guest links, their streams and the overlay guard.
  useEffect(() => initShareGuest(), [])

  // 1.x migration state: welcome notice, banners and the backup line (E0-FR-10, 28, 35).
  useEffect(() => initLegacyEvents(), [])

  // Push usage settings to main (reschedules its pollers) whenever they change.
  useEffect(() => {
    if (hydrated) syncUsageConfig(usage)
  }, [hydrated, usage])

  // Push the account switching policy to main whenever it changes.
  useEffect(() => {
    if (hydrated) syncAccountsConfig(claudeAccounts)
  }, [hydrated, claudeAccounts])

  // Push remote settings to main (starts/stops/restarts the server) on change.
  useEffect(() => {
    if (hydrated) syncRemoteConfig(remote)
  }, [hydrated, remote])

  // Push the Share switch and port to main (it starts or stops the share listener).
  useEffect(() => {
    if (hydrated) syncShareHostConfig({ enabled: shareEnabled, port: sharePort })
  }, [hydrated, shareEnabled, sharePort])

  // snaos CLI switch (E8-FR-22): main starts or stops the control server.
  useEffect(() => {
    if (hydrated) window.snApi.cli.setEnabled(cliEnabled)
  }, [hydrated, cliEnabled])

  // "PC awake": wire main's state stream once config is loaded (a tray pick is
  // persisted from it), then push the mode and the agent settings on change.
  useEffect(() => {
    if (!hydrated) return
    return initPowerEvents()
  }, [hydrated])
  useEffect(() => {
    if (hydrated) syncAwakeMode(awakeMode)
  }, [hydrated, awakeMode])
  useEffect(() => {
    if (hydrated) syncAgentSettings(agents)
  }, [hydrated, agents])

  // Headless mirror settings in main (E6-FR-06): pushed on every engine key change.
  useEffect(() => {
    if (!hydrated) return
    window.snApi.pty.setEngine(
      engineFromSettings({ terminalSnapshotMode: snapshotMode, terminalUnicode11: unicode11, persistScrollback, persistScrollbackLines, terminalShellIntegration: shellIntegration }),
    )
  }, [hydrated, snapshotMode, unicode11, persistScrollback, persistScrollbackLines, shellIntegration])

  // Agent sessions (E5-FR-10): load main's registry and start the consoles whose
  // agent was interrupted, even in workspaces not opened yet.
  useEffect(() => {
    if (hydrated) void mountInterruptedAgents()
  }, [hydrated])

  // Hibernation (E5-FR-25/26): main plans; the renderer reports what is on screen and wakes.
  useEffect(() => {
    if (!hydrated) return
    return initHibernation()
  }, [hydrated])

  // "Open in SnAgentsOS" (E4-FR-33): a folder from `--open` waits in main until
  // the store is hydrated, then activates its workspace or opens the wizard.
  useEffect(() => {
    if (!hydrated) return
    return initOpenRequests()
  }, [hydrated])

  // Mirror desktop state to phones once config is loaded (debounced snapshots).
  useEffect(() => {
    if (!hydrated) return
    return startRemoteSnapshotSync()
  }, [hydrated])

  // Git chip (E7-FR-06): feed main's GitService with targets, settings and agent nudges.
  useEffect(() => {
    if (!hydrated) return
    return startGitSync()
  }, [hydrated])

  // After config loads, check GitHub for a newer release (if enabled): 2.5 s
  // after hydration, then every 6 h. A find shows the update card in the toast
  // stack, never a modal, so the console keeps the keyboard (E4-FR-12, 18).
  useEffect(() => {
    if (!hydrated) return
    return startUpdateScheduler(() => useAppStore.getState().settings.autoCheckUpdates)
  }, [hydrated])

  // A silent update that did not land (app 2.4.0): one toast with [Retry].
  useEffect(() => {
    if (hydrated) void checkUpdateNotApplied()
  }, [hydrated])

  if (!hydrated) {
    return <div className="h-full w-full bg-bg-primary" />
  }

  return (
    <I18nProvider lang={language}>
      <div className="flex h-full w-full flex-col bg-bg-primary">
        {/* Crash resilience (E4-FR-20): neither fallback kills a console. */}
        <TitleBarBoundary>
          <TitleBar />
        </TitleBarBoundary>
        <LegacyBanner />
        <AppErrorBoundary>
          <AppBody />
        </AppErrorBoundary>
      </div>
      {/* Outside AppBody so toasts stay up even if the body fails (E4-FR-03). */}
      <NotificationStack />
    </I18nProvider>
  )
}

function AppBody() {
  const t = useT()
  const workspaces = useAppStore((s) => s.workspaces)
  const setWizardOpen = useAppStore((s) => s.setWizardOpen)

  // App-wide shortcuts: Ctrl+K palette, Alt+1..9 / Ctrl+Tab workspace switch.
  useGlobalKeys()
  // Drives per-console scheduled prompts (fires them at their set wall-clock time).
  usePaneScheduler()
  // Claude status: state events, notification sounds, viewed-set + config sync.
  useStatusEvents()

  const onNew = (): void => setWizardOpen(true)

  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-bg-primary">
      <Sidebar />
      <main className="relative min-w-0 flex-1">
        {workspaces.length > 0 ? (
          <WorkspaceHost />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
            <Logo size="lg" />
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold text-text-primary">{t('empty.title')}</h1>
              <p className="max-w-sm text-sm text-text-secondary">{t('empty.subtitle')}</p>
            </div>
            <Button onClick={onNew}>
              <Plus size={16} />
              {t('sidebar.newWorkspace')}
            </Button>
          </div>
        )}
        {/* Shared with me (app 2.4.0): a joined share over the local grid, even with no local workspace. */}
        <SharedWorkspaceHost />
        {/* Agents board (E5-FR-27): over the workspace area; the terminals stay mounted below. */}
        <AgentsBoard />
      </main>
      <SettingsModal />
      <ReleaseNotesModal />
      <UpdateCardHost />
      <RebrandNotice />
      <RemoteQrModal />
      <RemotePairingPrompt />
      <ShareDialog />
      <ShareJoinPrompt />
      <WorkspaceComposer />
      <NewWorkspaceWizard />
      <ExportRepoConfigDialog />
      <TrustDialog />
      <CommandPalette />
      <GlobalPromptDialog />
      <QuickCommandPopover />
      {/* "Resume interrupted chats?" (E5-FR-12): opened by the agent loader after hydrate. */}
      <ResumeDialog />
      {/* Worktree per console (E7-FR-27/30/31/36): launch and close dialogs. */}
      <WorktreeLaunchDialog />
      <WorktreeCloseDialog />
      {/* Shared with me (app 2.4.0): join an invite, confirm a link from a shared console. */}
      <JoinShareDialog />
      <ConfirmLinkDialog />
    </div>
  )
}
