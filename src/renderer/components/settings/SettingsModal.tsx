import { useMemo, useState, type ComponentType } from 'react'
import { Activity, Bot, Database, FileText, Info, Keyboard, Languages, Palette, PlugZap, Power, Search, TerminalSquare, type LucideIcon } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { Modal } from '@/components/common/Modal'
import { cn } from '@/lib/cn'
import { AppearanceSection } from './sections/AppearanceSection'
import { TerminalSection } from './sections/TerminalSection'
import { LanguageSection } from './sections/LanguageSection'
import { AgentsSection } from './sections/AgentsSection'
import { ConnectionsSection } from './sections/ConnectionsSection'
import { StartupSection } from './sections/StartupSection'
import { SnippetsSection } from './sections/SnippetsSection'
import { KeymapSection } from './sections/KeymapSection'
import { DataSection } from './sections/DataSection'
import { UsageSection } from './sections/UsageSection'
import { AboutSection } from './sections/AboutSection'

type CategoryId =
  | 'appearance'
  | 'terminal'
  | 'language'
  | 'agents'
  | 'connections'
  | 'snippets'
  | 'startup'
  | 'keys'
  | 'data'
  | 'usage'
  | 'about'

interface Category {
  id: CategoryId
  labelKey: MessageKey
  icon: LucideIcon
  keywords: string[]
}

// Ordered most-important → least (cosmetic/info sink to the bottom).
const CATEGORIES: Category[] = [
  { id: 'terminal', labelKey: 'settings.cat.terminal', icon: TerminalSquare, keywords: ['shell', 'font', 'fuente', 'scrollback', 'powershell'] },
  { id: 'agents', labelKey: 'settings.cat.agents', icon: Bot, keywords: ['preset', 'model', 'modelo', 'agent', 'agente', 'claude', 'codex'] },
  { id: 'connections', labelKey: 'settings.cat.connections', icon: PlugZap, keywords: ['ssh', 'connection', 'conexion', 'conexión', 'setup', 'login', 'password', 'contraseña', 'dedi', 'server', 'servidor', 'expect'] },
  { id: 'snippets', labelKey: 'settings.cat.snippets', icon: FileText, keywords: ['snippet', 'prompt', 'plantilla', 'texto', 'text'] },
  { id: 'startup', labelKey: 'settings.cat.startup', icon: Power, keywords: ['startup', 'inicio', 'tray', 'bandeja', 'launch', 'close', 'cerrar', 'shortcut', 'atajo', 'hotkey'] },
  { id: 'keys', labelKey: 'settings.cat.keys', icon: Keyboard, keywords: ['keys', 'teclas', 'keyboard', 'teclado', 'shortcut', 'atajo', 'keybinding', 'binding', 'palette', 'paleta'] },
  { id: 'data', labelKey: 'settings.cat.data', icon: Database, keywords: ['data', 'datos', 'export', 'exportar', 'import', 'importar', 'backup', 'respaldo'] },
  { id: 'appearance', labelKey: 'settings.cat.appearance', icon: Palette, keywords: ['theme', 'color', 'tema', 'apariencia', 'custom'] },
  { id: 'language', labelKey: 'settings.cat.language', icon: Languages, keywords: ['language', 'idioma', 'english', 'español', 'spanish'] },
  { id: 'usage', labelKey: 'settings.cat.usage', icon: Activity, keywords: ['usage', 'uso', 'ram', 'cpu', 'memory', 'memoria', 'performance', 'rendimiento'] },
  { id: 'about', labelKey: 'settings.cat.about', icon: Info, keywords: ['about', 'acerca', 'version', 'versión'] },
]

function matches(cat: Category, q: string, t: TFn): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return t(cat.labelKey).toLowerCase().includes(needle) || cat.keywords.some((k) => k.includes(needle))
}

const SECTIONS: Record<CategoryId, ComponentType> = {
  appearance: AppearanceSection,
  terminal: TerminalSection,
  language: LanguageSection,
  agents: AgentsSection,
  connections: ConnectionsSection,
  snippets: SnippetsSection,
  startup: StartupSection,
  keys: KeymapSection,
  data: DataSection,
  usage: UsageSection,
  about: AboutSection,
}

export function SettingsModal() {
  const t = useT()
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)

  const [active, setActive] = useState<CategoryId>('terminal')
  const [query, setQuery] = useState('')

  const visible = useMemo(() => CATEGORIES.filter((c) => matches(c, query, t)), [query, t])
  const current = visible.some((c) => c.id === active) ? active : (visible[0]?.id ?? 'terminal')
  const Section = SECTIONS[current]
  const currentLabel = CATEGORIES.find((c) => c.id === current)?.labelKey ?? 'settings.title'

  const close = (): void => {
    setQuery('')
    setOpen(false)
  }

  return (
    <Modal open={open} onClose={close} title={t('settings.title')} className="max-w-4xl">
      <div className="flex flex-col">
        <div className="shrink-0 border-b border-border p-3">
          <div className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3">
            <Search size={15} className="shrink-0 text-text-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.search')}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
            />
          </div>
        </div>

        <div className="flex h-[62vh]">
          <nav className="w-52 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2">
            {visible.map((cat) => {
              const Icon = cat.icon
              const isActive = cat.id === current
              return (
                <button
                  key={cat.id}
                  onClick={() => setActive(cat.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-btn px-2.5 py-2 text-left text-sm transition-colors',
                    isActive
                      ? 'bg-card text-text-primary'
                      : 'text-text-secondary hover:bg-card/60 hover:text-text-primary',
                  )}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t(cat.labelKey)}</span>
                </button>
              )
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <h3 className="mb-5 text-base font-semibold text-text-primary">{t(currentLabel)}</h3>
            <Section />
          </div>
        </div>
      </div>
    </Modal>
  )
}
