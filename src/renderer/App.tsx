import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { startPersistence } from '@/lib/persist'
import { applyTheme } from '@/themes'
import { I18nProvider, useT } from '@/i18n'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { WorkspaceHost } from '@/components/layout/WorkspaceHost'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { NewWorkspaceWizard } from '@/components/wizard/NewWorkspaceWizard'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

export function App() {
  const hydrated = useAppStore((s) => s.hydrated)
  const hydrate = useAppStore((s) => s.hydrate)
  const theme = useAppStore((s) => s.settings.theme)
  const customColors = useAppStore((s) => s.settings.customColors)
  const language = useAppStore((s) => s.settings.language)

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
      <NewWorkspaceWizard />
    </div>
  )
}
