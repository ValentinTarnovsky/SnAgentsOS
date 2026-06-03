import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useUpdaterStore, initUpdaterEvents } from '@/lib/updater'
import { initUsageEvents, syncUsageConfig } from '@/lib/usageStore'
import { startPersistence } from '@/lib/persist'
import { useGlobalKeys } from '@/lib/useGlobalKeys'
import { usePaneScheduler } from '@/lib/usePaneScheduler'
import { applyTheme } from '@/themes'
import { I18nProvider, useT } from '@/i18n'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { WorkspaceHost } from '@/components/layout/WorkspaceHost'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { UpdateModal } from '@/components/updates/UpdateModal'
import { NewWorkspaceWizard } from '@/components/wizard/NewWorkspaceWizard'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { CommandPalette } from '@/components/ui/CommandPalette'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

export function App() {
  const hydrated = useAppStore((s) => s.hydrated)
  const hydrate = useAppStore((s) => s.hydrate)
  const theme = useAppStore((s) => s.settings.theme)
  const customColors = useAppStore((s) => s.settings.customColors)
  const language = useAppStore((s) => s.settings.language)
  const usage = useAppStore((s) => s.settings.usage)

  // Load persisted config once, then start the debounced persistence writer.
  useEffect(() => {
    let unsub: (() => void) | undefined
    window.snApi.config
      .load()
      .then((cfg) => {
        hydrate(cfg)
        unsub = startPersistence()
      })
      .catch(() => hydrate(null))
    return () => unsub?.()
  }, [hydrate])

  // Apply the active theme to CSS custom properties (xterm reads it separately).
  useEffect(() => {
    applyTheme(theme, customColors)
  }, [theme, customColors])

  // Keep the download-progress stream wired for the whole app lifetime.
  useEffect(() => initUpdaterEvents(), [])

  // Keep the usage-snapshot stream wired for the whole app lifetime.
  useEffect(() => initUsageEvents(), [])

  // Push usage settings to main (reschedules its pollers) whenever they change.
  useEffect(() => {
    if (hydrated) syncUsageConfig(usage)
  }, [hydrated, usage])

  // After config loads, check GitHub for a newer release (if enabled) and, when
  // one is found, open the "update available" prompt. Slightly delayed so it
  // never competes with the first paint.
  useEffect(() => {
    if (!hydrated) return
    if (!useAppStore.getState().settings.autoCheckUpdates) return
    const timer = setTimeout(() => {
      void useUpdaterStore
        .getState()
        .check()
        .then((info) => {
          if (info?.available) useUpdaterStore.getState().openPrompt()
        })
    }, 2500)
    return () => clearTimeout(timer)
  }, [hydrated])

  if (!hydrated) {
    return <div className="h-full w-full bg-bg-primary" />
  }

  return (
    <I18nProvider lang={language}>
      <div className="flex h-full w-full flex-col bg-bg-primary">
        <TitleBar />
        <AppBody />
      </div>
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

  const onNew = (): void => setWizardOpen(true)

  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-bg-primary">
      <Sidebar />
      <main className="min-w-0 flex-1">
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
      </main>
      <SettingsModal />
      <UpdateModal />
      <NewWorkspaceWizard />
      <CommandPalette />
    </div>
  )
}
