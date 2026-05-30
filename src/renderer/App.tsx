import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { startPersistence } from '@/lib/persist'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { WorkspaceView } from '@/components/workspace/WorkspaceView'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

const ACCENT_HEX: Record<string, string> = {
  violet: '#6366f1',
  purple: '#8b5cf6',
  blue: '#60a5fa',
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
}

export function App() {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const accent = useAppStore((s) => s.settings.accent)
  const hydrated = useAppStore((s) => s.hydrated)
  const hydrate = useAppStore((s) => s.hydrate)
  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? null

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

  // Remap the primary accent token to the chosen accent.
  useEffect(() => {
    document.documentElement.style.setProperty('--color-accent-violet', ACCENT_HEX[accent])
  }, [accent])

  const onNew = async (): Promise<void> => {
    const dir = await window.snApi.dialog.openDirectory()
    if (dir) createWorkspace(basename(dir), dir)
  }

  if (!hydrated) {
    return <div className="h-full w-full bg-bg-primary" />
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg-primary">
      <Sidebar />
      <main className="min-w-0 flex-1">
        {active ? (
          <WorkspaceView workspace={active} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
            <Logo size="lg" />
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold text-text-primary">Multi Command Consoles</h1>
              <p className="max-w-sm text-sm text-text-secondary">
                Creá un workspace en el directorio que quieras y abrí varias consolas a la vez.
              </p>
            </div>
            <Button onClick={onNew}>
              <Plus size={16} />
              Nuevo workspace
            </Button>
          </div>
        )}
      </main>
      <SettingsModal />
    </div>
  )
}
