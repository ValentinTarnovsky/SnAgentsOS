import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc-contract'
import { Logo } from '@/components/ui/Logo'
import { TerminalPane } from '@/components/terminal/TerminalPane'

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    window.snApi.app.info().then(setInfo).catch(() => undefined)
  }, [])

  return (
    <div className="flex h-full w-full flex-col bg-bg-primary">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <Logo size="sm" />
        <span className="font-mono text-xs text-text-secondary">
          {info ? `v${info.version} · ${info.platform}/${info.arch}` : ''}
        </span>
      </header>
      <main className="min-h-0 flex-1">
        <TerminalPane paneId="main" />
      </main>
    </div>
  )
}
