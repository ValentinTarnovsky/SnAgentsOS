import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Activity, Bell, Bot, Database, DownloadCloud, FileText, Gauge, Info, Keyboard, Languages, Palette, PlugZap, Power, Search, Smartphone, TerminalSquare, type LucideIcon } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT, type TFn } from '@/i18n'
import { Modal } from '@/components/common/Modal'
import { cn } from '@/lib/cn'
import { formatAccel, resolveKeymap } from '@/lib/keymap'
import { SearchSummaryRow, Toggle } from './ui'
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  highlightRanges,
  parseSettingsTarget,
  readSettingPath,
  searchSettings,
  searchTokens,
  settingDomId,
  settingsPatchForPath,
  type CategoryId,
  type SettingSearchEntry,
} from './searchCatalog'
import { AppearanceSection } from './sections/AppearanceSection'
import { TerminalSection } from './sections/TerminalSection'
import { LanguageSection } from './sections/LanguageSection'
import { AgentsSection } from './sections/AgentsSection'
import { ConnectionsSection } from './sections/ConnectionsSection'
import { StartupSection } from './sections/StartupSection'
import { NotificationsSection } from './sections/NotificationsSection'
import { SnippetsSection } from './sections/SnippetsSection'
import { KeymapSection } from './sections/KeymapSection'
import { DataSection } from './sections/DataSection'
import { UsageSection } from './sections/UsageSection'
import { AiUsageSection } from './sections/AiUsageSection'
import { RemoteSection } from './sections/RemoteSection'
import { UpdatesSection } from './sections/UpdatesSection'
import { AboutSection } from './sections/AboutSection'

const ICONS: Record<CategoryId, LucideIcon> = {
  terminal: TerminalSquare,
  agents: Bot,
  connections: PlugZap,
  snippets: FileText,
  startup: Power,
  notifications: Bell,
  keys: Keyboard,
  data: Database,
  appearance: Palette,
  language: Languages,
  aiusage: Gauge,
  usage: Activity,
  remote: Smartphone,
  updates: DownloadCloud,
  about: Info,
}

const SECTIONS: Record<CategoryId, ComponentType> = {
  appearance: AppearanceSection,
  terminal: TerminalSection,
  language: LanguageSection,
  agents: AgentsSection,
  connections: ConnectionsSection,
  snippets: SnippetsSection,
  startup: StartupSection,
  notifications: NotificationsSection,
  keys: KeymapSection,
  data: DataSection,
  aiusage: AiUsageSection,
  usage: UsageSection,
  remote: RemoteSection,
  updates: UpdatesSection,
  about: AboutSection,
}

/** How long a deep-linked row keeps its accent ring (E4-FR-27). */
const FLASH_MS = 1200

/** `text` with the query tokens wrapped in <mark> (accent- and case-insensitive). */
function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query)
  if (ranges.length === 0) return <>{text}</>
  const out: ReactNode[] = []
  let at = 0
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s))
    out.push(
      <mark key={i} className="rounded-sm bg-accent-violet/30 px-px text-text-primary">
        {text.slice(s, e)}
      </mark>,
    )
    at = e
  })
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

/** An inline switch for a plain boolean row, bound to the store with no effects. */
function SearchToggle({ entry }: { entry: SettingSearchEntry }) {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const toggle = entry.toggle!
  const disabled = (toggle.disabledUnless ?? []).some((p) => !readSettingPath(settings, p))
  return (
    <Toggle
      checked={Boolean(readSettingPath(settings, toggle.path))}
      disabled={disabled}
      onChange={(v) => updateSettings(settingsPatchForPath(useAppStore.getState().settings, toggle.path, v))}
    />
  )
}

function SearchResults({
  groups,
  query,
  t,
  onOpen,
}: {
  groups: ReturnType<typeof searchSettings>
  query: string
  t: TFn
  onOpen: (entry: SettingSearchEntry) => void
}) {
  if (groups.length === 0) {
    return (
      <p data-search-empty className="py-10 text-center text-sm text-text-secondary">
        {t('settings.search.empty', { q: query.trim() })}
      </p>
    )
  }
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.category} id={`settings-group-${g.category}`} data-search-group={g.category} className="scroll-mt-2">
          <h4 className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            <Highlight text={t(CATEGORY_LABEL[g.category])} query={query} />
          </h4>
          <div className="space-y-0.5">
            {g.entries.map((entry) => {
              const title = t(entry.titleKey)
              return (
                <SearchSummaryRow
                  key={entry.id}
                  id={entry.id}
                  title={<Highlight text={title} query={query} />}
                  description={entry.descriptionKey ? <Highlight text={t(entry.descriptionKey)} query={query} /> : undefined}
                  crumb={entry.groupKey ? <Highlight text={t(entry.groupKey)} query={query} /> : undefined}
                  control={entry.toggle ? <SearchToggle entry={entry} /> : undefined}
                  openLabel={t('settings.search.open', { title })}
                  onOpen={() => onOpen(entry)}
                />
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

export function SettingsModal() {
  const t = useT()
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const settingsCategory = useAppStore((s) => s.settingsCategory)
  const query = useAppStore((s) => s.settingsQuery)
  const setQuery = useAppStore((s) => s.setSettingsQuery)
  const anchor = useAppStore((s) => s.settingsAnchor)
  const setAnchor = useAppStore((s) => s.setSettingsAnchor)
  const keymap = useAppStore((s) => s.settings.keymap)

  const [active, setActive] = useState<CategoryId>('terminal')
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Apply a deep-link target (openSettings('remote') or 'notifications#sound')
  // once, then clear it. The row part stays in settingsAnchor until it renders.
  useEffect(() => {
    if (open && settingsCategory) {
      const { category } = parseSettingsTarget(settingsCategory)
      if (category) setActive(category)
      useAppStore.setState({ settingsCategory: null })
    }
  }, [open, settingsCategory])

  const searching = searchTokens(query).length > 0
  const groups = useMemo(() => {
    if (!searching) return []
    const accels = resolveKeymap(keymap)
    // Key rows also match their current accelerator ("ctrl k").
    const extraFor = (entry: SettingSearchEntry): string[] => {
      if (entry.category !== 'keys') return []
      const accel = accels[entry.id.slice(5) as keyof typeof accels]
      return accel ? [accel, formatAccel(accel)] : []
    }
    return searchSettings(query, t, extraFor)
  }, [searching, query, t, keymap])
  const counts = useMemo(() => new Map(groups.map((g) => [g.category, g.entries.length])), [groups])

  const current = active
  const Section = SECTIONS[current]

  // Scroll to the deep-linked row once its section is mounted (effects run
  // after the commit, so it is in the DOM), ring it for 1200 ms, then drop the
  // anchor. A missing row just leaves the category open.
  useEffect(() => {
    if (!open || !anchor || searching) return
    if (!anchor.startsWith(current + '.')) return
    const el = document.getElementById(settingDomId(anchor))
    setAnchor(null)
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    document.querySelectorAll('[data-setting-flash]').forEach((n) => n.removeAttribute('data-setting-flash'))
    el.setAttribute('data-setting-flash', '')
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => el.removeAttribute('data-setting-flash'), FLASH_MS)
  }, [open, anchor, current, searching, setAnchor])

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
  }, [])

  const close = (): void => setOpen(false)

  const openEntry = (entry: SettingSearchEntry): void => {
    setActive(entry.category)
    setQuery('')
    setAnchor(entry.summary ? null : entry.id)
  }

  const onNav = (cat: CategoryId): void => {
    if (searching) document.getElementById(`settings-group-${cat}`)?.scrollIntoView({ block: 'start' })
    else setActive(cat)
  }

  const navCats = searching ? CATEGORY_ORDER.filter((c) => counts.has(c)) : CATEGORY_ORDER
  const total = groups.reduce((n, g) => n + g.entries.length, 0)

  return (
    <Modal open={open} onClose={close} title={t('settings.title')} className="max-w-4xl">
      <div className="flex flex-col">
        <div className="shrink-0 border-b border-border p-3">
          <div className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3">
            <Search size={15} className="shrink-0 text-text-secondary" />
            <input
              autoFocus
              spellCheck={false}
              data-settings-search
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  // First Esc clears the query; the next one closes (Modal).
                  e.preventDefault()
                  e.stopPropagation()
                  setQuery('')
                } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && searching) {
                  e.preventDefault()
                  const first = groups[0]?.entries[0]
                  if (first) openEntry(first)
                }
              }}
              placeholder={t('settings.search')}
              aria-label={t('settings.search')}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
            />
          </div>
        </div>

        <div className="flex h-[62vh]">
          <nav className="w-52 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2">
            {navCats.map((id) => {
              const Icon = ICONS[id]
              const isActive = !searching && id === current
              const count = counts.get(id)
              return (
                <button
                  key={id}
                  data-settings-nav={id}
                  onClick={() => onNav(id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-btn px-2.5 py-2 text-left text-sm transition-colors',
                    isActive
                      ? 'bg-card text-text-primary'
                      : 'text-text-secondary hover:bg-card/60 hover:text-text-primary',
                  )}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t(CATEGORY_LABEL[id])}</span>
                  {searching && count !== undefined && (
                    <span data-search-count className="shrink-0 rounded-full bg-bg-secondary px-1.5 text-[11px] tabular-nums text-text-secondary">
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            {searching ? (
              <>
                <h3 className="sr-only" aria-live="polite">
                  {t('settings.search.results', { count: total })}
                </h3>
                <SearchResults groups={groups} query={query} t={t} onOpen={openEntry} />
              </>
            ) : (
              <>
                <h3 className="mb-5 text-base font-semibold text-text-primary">{t(CATEGORY_LABEL[current])}</h3>
                <Section />
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
