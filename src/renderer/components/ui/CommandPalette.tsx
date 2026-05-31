import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Palette, PanelLeft, Plus, Search, Settings } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { insertToConsole } from '@/lib/insertToConsole'
import { useT } from '@/i18n'
import { iconFor, type IconComponent } from '@/lib/icons'
import { THEME_LIST } from '@/themes'
import { cn } from '@/lib/cn'

interface Command {
  id: string
  label: string
  hint?: string
  icon?: IconComponent
  run: () => void
}

/** Case-insensitive subsequence match (fuzzy). */
function matches(needle: string, hay: string): boolean {
  if (!needle) return true
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

/** Ctrl/Cmd+K fuzzy launcher for switching workspaces and running actions. */
export function CommandPalette() {
  const t = useT()
  const open = useAppStore((s) => s.paletteOpen)
  const setOpen = useAppStore((s) => s.setPaletteOpen)
  const workspaces = useAppStore((s) => s.workspaces)
  const presets = useAppStore((s) => s.presets)
  const snippets = useAppStore((s) => s.snippets)
  const activeId = useAppStore((s) => s.activeWorkspaceId)
  const setActive = useAppStore((s) => s.setActive)
  const setWizardOpen = useAppStore((s) => s.setWizardOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const addPane = useAppStore((s) => s.addPane)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: 'new-ws', label: t('sidebar.newWorkspace'), hint: t('palette.general'), icon: Plus, run: () => setWizardOpen(true) },
      { id: 'settings', label: t('sidebar.settings'), hint: t('palette.general'), icon: Settings, run: () => setSettingsOpen(true) },
      { id: 'toggle-sidebar', label: t('palette.toggleSidebar'), hint: t('palette.general'), icon: PanelLeft, run: () => toggleSidebar() },
    ]
    for (const w of workspaces) {
      cmds.push({ id: `ws-${w.id}`, label: w.name, hint: t('palette.workspace'), icon: iconFor(w.panes[0]?.icon), run: () => setActive(w.id) })
    }
    if (activeId) {
      for (const p of presets) {
        cmds.push({
          id: `pane-${p.id}`,
          label: `${t('palette.newConsole')}: ${p.name}`,
          hint: t('palette.console'),
          icon: iconFor(p.icon),
          run: () => addPane(activeId, { type: p.type, presetId: p.id, title: p.name, color: p.color, icon: p.icon }),
        })
      }
    }
    for (const snip of snippets) {
      cmds.push({
        id: `snip-${snip.id}`,
        label: `${t('palette.snippet')}: ${snip.name}`,
        hint: t('palette.snippet'),
        icon: FileText,
        run: () => insertToConsole(snip.text),
      })
    }
    for (const th of THEME_LIST) {
      cmds.push({ id: `theme-${th.name}`, label: `${t('palette.theme')}: ${th.label}`, hint: t('palette.appearance'), icon: Palette, run: () => updateSettings({ theme: th.name }) })
    }
    return cmds
  }, [workspaces, presets, snippets, activeId, t, setActive, setWizardOpen, setSettingsOpen, toggleSidebar, addPane, updateSettings])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => matches(q, c.label.toLowerCase()))
  }, [commands, query])

  useEffect(() => {
    setIdx(0)
  }, [query, open])

  if (!open) return null

  const close = (): void => {
    setQuery('')
    setOpen(false)
  }
  const runAt = (i: number): void => {
    const c = filtered[i]
    if (!c) return
    close()
    c.run()
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-6 pt-[12vh]">
      <div className="absolute inset-0 bg-black/50" onClick={close} />
      <div className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={16} className="shrink-0 text-text-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((n) => Math.min(n + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((n) => Math.max(n - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runAt(idx)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            placeholder={t('palette.placeholder')}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-text-secondary">{t('palette.empty')}</p>
          )}
          {filtered.map((c, i) => {
            const Icon = c.icon
            return (
              <button
                key={c.id}
                onMouseEnter={() => setIdx(i)}
                onClick={() => runAt(i)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                  i === idx ? 'bg-bg-secondary' : 'hover:bg-bg-secondary/50',
                )}
              >
                {Icon && <Icon size={15} className="shrink-0 text-text-secondary" />}
                <span className="min-w-0 flex-1 truncate text-text-primary">{c.label}</span>
                {c.hint && <span className="shrink-0 text-[11px] text-text-secondary">{c.hint}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
