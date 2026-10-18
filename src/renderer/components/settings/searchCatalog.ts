import type { Settings } from '@shared/types'
import type { MessageKey } from '@/i18n'
import { KEY_ACTIONS } from '@/lib/keymap'

/**
 * Per-row settings search (E4-FR-26..28). A static catalog: in search mode the
 * modal renders these entries, never the live sections, so searching triggers
 * no section effect (update check, metrics polling, hooks health, login item).
 */

export type CategoryId =
  | 'appearance'
  | 'terminal'
  | 'language'
  | 'agents'
  | 'connections'
  | 'snippets'
  | 'startup'
  | 'notifications'
  | 'keys'
  | 'data'
  | 'aiusage'
  | 'usage'
  | 'remote'
  | 'git'
  | 'updates'
  | 'about'

/** Nav order, most important first (cosmetic and info sink to the bottom). */
export const CATEGORY_ORDER: CategoryId[] = [
  'terminal',
  'agents',
  'connections',
  'snippets',
  'startup',
  'notifications',
  'keys',
  'data',
  'appearance',
  'language',
  'aiusage',
  'usage',
  'remote',
  'git',
  'updates',
  'about',
]

export const CATEGORY_LABEL: Record<CategoryId, MessageKey> = {
  appearance: 'settings.cat.appearance',
  terminal: 'settings.cat.terminal',
  language: 'settings.cat.language',
  agents: 'settings.cat.agents',
  connections: 'settings.cat.connections',
  snippets: 'settings.cat.snippets',
  startup: 'settings.cat.startup',
  notifications: 'settings.cat.notifications',
  keys: 'settings.cat.keys',
  data: 'settings.cat.data',
  aiusage: 'settings.cat.aiusage',
  usage: 'settings.cat.usage',
  remote: 'settings.cat.remote',
  git: 'settings.cat.git',
  updates: 'settings.cat.updates',
  about: 'settings.cat.about',
}

/**
 * An inline switch for a plain boolean setting whose live control only calls
 * updateSettings (no IPC side effect). `disabledUnless` mirrors the live
 * row's disabled state: every listed path must be truthy.
 */
export interface SearchToggle {
  path: string
  disabledUnless?: string[]
}

export interface SettingSearchEntry {
  /** '<category>.<key>'; DOM id = settingDomId(id). Rows from KEY_ACTIONS: 'keys.<actionId>'. */
  id: string
  category: CategoryId
  titleKey: MessageKey
  descriptionKey?: MessageKey
  /** Extra search terms (both languages: the UI language can change any time). */
  keywords?: string[]
  /** A custom block that deep-links to its category instead of a real row. */
  summary?: boolean
  /** Sub-block shown as a breadcrumb under the category ("Behavior"). */
  groupKey?: MessageKey
  toggle?: SearchToggle
}

const e = (
  id: string,
  titleKey: MessageKey,
  descriptionKey?: MessageKey,
  extra: Partial<SettingSearchEntry> = {},
): SettingSearchEntry => ({ id, category: id.split('.')[0] as CategoryId, titleKey, descriptionKey, ...extra })

/** Every SettingRow/ToggleRow with a searchId, plus one summary per custom block. */
export const SETTINGS_CATALOG: SettingSearchEntry[] = [
  // Terminal
  e('terminal.shellWin', 'settings.shellWin', undefined, { keywords: ['shell', 'powershell', 'cmd', 'pwsh', 'windows'] }),
  e('terminal.shellMac', 'settings.shellMac', undefined, { keywords: ['shell', 'zsh', 'mac'] }),
  e('terminal.shellLinux', 'settings.shellLinux', undefined, { keywords: ['shell', 'bash', 'linux'] }),
  e('terminal.fontFamily', 'settings.fontFamily', undefined, { keywords: ['font', 'fuente', 'tipografia'] }),
  e('terminal.fontSize', 'settings.fontSize', undefined, { keywords: ['font', 'fuente', 'size', 'tamano', 'zoom'] }),
  e('terminal.scrollback', 'settings.scrollback', undefined, { keywords: ['scrollback', 'history', 'historial', 'lines', 'lineas'] }),
  e('terminal.infiniteScrollback', 'settings.infiniteScrollback', 'settings.infiniteScrollbackHint', { keywords: ['scrollback', 'history', 'historial'], toggle: { path: 'infiniteScrollback' } }),
  e('terminal.renderer', 'settings.renderer', 'settings.rendererHint', { keywords: ['canvas', 'webgl', 'gpu'] }),
  e('terminal.selectionOverride', 'settings.selectionOverride', 'settings.selectionOverrideHint', { keywords: ['selection', 'seleccion', 'mouse', 'copy', 'copiar'], toggle: { path: 'terminalSelectionOverride' } }),
  e('terminal.unicode11', 'settings.unicode11', 'settings.unicode11Hint', { keywords: ['unicode', 'emoji', 'width', 'ancho'], toggle: { path: 'terminalUnicode11' } }),
  e('terminal.agentEndChip', 'settings.agentEndChip', 'settings.agentEndChipHint', { keywords: ['exit', 'salida', 'claude', 'codex'], toggle: { path: 'terminalAgentEndChip' } }),

  // Agents
  e('agents.resume', 'settings.agents.resume', 'settings.agents.resumeHint', { groupKey: 'settings.agents.behavior', keywords: ['resume', 'retomar', 'session', 'sesion', 'chat', 'restart', 'reinicio'] }),
  e('agents.awake', 'settings.agents.awake', 'settings.agents.awakeHint', { groupKey: 'settings.agents.behavior', keywords: ['awake', 'despierta', 'sleep', 'suspender', 'suspension', 'energy', 'energia', 'power'] }),
  e('agents.awakeDisplay', 'settings.agents.awakeDisplay', 'settings.agents.awakeDisplayHint', { groupKey: 'settings.agents.behavior', keywords: ['awake', 'despierta', 'display', 'pantalla', 'sleep', 'screen'] }),
  e('agents.rows', 'settings.agents.rows', 'settings.agents.rowsHint', { groupKey: 'settings.agents.behavior', keywords: ['rows', 'filas', 'sidebar', 'barra lateral'], toggle: { path: 'agents.sidebarAgentRows' } }),
  e('agents.topicAsTitle', 'settings.agents.topicAsTitle', 'settings.agents.topicAsTitleHint', { groupKey: 'settings.agents.behavior', keywords: ['topic', 'tema', 'title', 'titulo'], toggle: { path: 'agents.topicAsTitle' } }),
  e('agents.ctrlDigit', 'settings.agents.ctrlDigit', 'settings.agents.ctrlDigitHint', { groupKey: 'settings.agents.behavior', keywords: ['ctrl', 'focus', 'foco', 'shortcut', 'atajo'], toggle: { path: 'agents.ctrlDigitFocus' } }),
  e('agents.presets', 'settings.search.agentsPresets', 'settings.search.agentsPresetsHint', { summary: true, keywords: ['preset', 'model', 'modelo', 'agent', 'agente', 'claude', 'codex', 'command', 'comando'] }),

  // Connections, snippets
  e('connections.profiles', 'settings.search.connections', 'settings.search.connectionsHint', { summary: true, keywords: ['ssh', 'connection', 'conexion', 'setup', 'login', 'password', 'contrasena', 'server', 'servidor', 'expect'] }),
  e('snippets.list', 'settings.search.snippets', 'settings.search.snippetsHint', { summary: true, keywords: ['snippet', 'prompt', 'plantilla', 'template', 'texto', 'text'] }),

  // Startup
  e('startup.restoreLast', 'settings.restoreLast', undefined, { keywords: ['restore', 'restaurar', 'workspace', 'inicio', 'startup'], toggle: { path: 'restoreLastWorkspace' } }),
  e('startup.confirmClose', 'settings.confirmClose', undefined, { keywords: ['close', 'cerrar', 'confirm', 'confirmar'], toggle: { path: 'confirmCloseRunning' } }),
  e('startup.closeToTray', 'settings.closeToTray', undefined, { keywords: ['tray', 'bandeja', 'close', 'cerrar', 'minimize', 'minimizar'] }),
  e('startup.launchOnStartup', 'settings.launchOnStartup', undefined, { keywords: ['startup', 'inicio', 'login', 'windows', 'boot', 'arranque'] }),
  e('startup.globalHotkey', 'settings.globalHotkey', 'settings.globalHotkeyHint', { keywords: ['hotkey', 'shortcut', 'atajo', 'global', 'show', 'mostrar'] }),

  // Notifications
  e('notifications.enabled', 'notif.enabled', 'notif.enabledHint', { keywords: ['notifications', 'notificaciones', 'desktop', 'escritorio', 'alert', 'alerta'], toggle: { path: 'notifications.enabled' } }),
  e('notifications.done', 'notif.done', undefined, { keywords: ['done', 'termino', 'turn', 'turno'], toggle: { path: 'notifications.notifyDone', disabledUnless: ['notifications.enabled'] } }),
  e('notifications.action', 'notif.action', undefined, { keywords: ['action', 'accion', 'permission', 'permiso', 'error'], toggle: { path: 'notifications.notifyAction', disabledUnless: ['notifications.enabled'] } }),
  e('notifications.flash', 'notif.flash', undefined, { keywords: ['taskbar', 'barra de tareas', 'flash', 'parpadear'], toggle: { path: 'notifications.flashTaskbar', disabledUnless: ['notifications.enabled'] } }),
  e('notifications.inAppWhenFocused', 'notif.inApp', 'notif.inAppHint', { keywords: ['toast', 'card', 'tarjeta', 'focused', 'enfocada'], toggle: { path: 'notifications.inAppWhenFocused', disabledUnless: ['notifications.enabled'] } }),
  e('notifications.sound', 'notif.sound', undefined, { keywords: ['sound', 'sonido', 'volume', 'volumen', 'chime', 'ping', 'pop', 'audio'], toggle: { path: 'notifications.sound', disabledUnless: ['notifications.enabled'] } }),
  e('notifications.hooks', 'notif.hooks.title', 'notif.hooks.desc', { keywords: ['claude', 'hooks', 'status', 'estado', 'integration', 'integracion'] }),
  e('notifications.codex', 'notif.codex.title', 'notif.codex.desc', { keywords: ['codex', 'status', 'estado', 'integration', 'integracion'], toggle: { path: 'notifications.codexEnabled' } }),
  e('notifications.discord', 'notif.discord.title', 'notif.discord.desc', { keywords: ['discord', 'webhook'], toggle: { path: 'notifications.discord.enabled' } }),
  e('notifications.discordAction', 'notif.action', undefined, { groupKey: 'notif.discord.title', keywords: ['discord', 'webhook'], toggle: { path: 'notifications.discord.notifyAction', disabledUnless: ['notifications.discord.enabled'] } }),
  e('notifications.discordDone', 'notif.done', undefined, { groupKey: 'notif.discord.title', keywords: ['discord', 'webhook'], toggle: { path: 'notifications.discord.notifyDone', disabledUnless: ['notifications.discord.enabled'] } }),

  // Data
  e('data.backup', 'settings.search.data', 'settings.search.dataHint', { summary: true, keywords: ['data', 'datos', 'export', 'exportar', 'import', 'importar', 'backup', 'respaldo'] }),

  // Appearance, language
  e('appearance.theme', 'settings.theme', 'settings.themeHint', { keywords: ['theme', 'tema', 'color', 'dark', 'oscuro', 'light', 'claro'] }),
  e('appearance.customColors', 'settings.customColors', 'settings.customColorsHint', { keywords: ['color', 'custom', 'personalizado', 'palette'] }),
  e('language.language', 'settings.language', 'settings.languageHint', { keywords: ['language', 'idioma', 'english', 'ingles', 'espanol', 'spanish'] }),

  // AI usage
  e('aiusage.enable', 'aiusage.enable', 'aiusage.enableHint', { keywords: ['usage', 'uso', 'tokens', 'limit', 'limite', 'quota', 'cuota', 'bars', 'barras'], toggle: { path: 'usage.enabled' } }),
  e('aiusage.showStatus', 'aiusage.showStatus', 'aiusage.showStatusHint', { keywords: ['status', 'estado', 'anthropic'], toggle: { path: 'usage.showStatus', disabledUnless: ['usage.enabled'] } }),
  e('aiusage.refreshOnFocus', 'aiusage.refreshOnFocus', 'aiusage.refreshOnFocusHint', { keywords: ['refresh', 'actualizar', 'interval', 'intervalo'], toggle: { path: 'usage.refreshOnFocus', disabledUnless: ['usage.enabled'] } }),
  e('aiusage.custom', 'aiusage.customTitle', 'aiusage.customHint', { keywords: ['custom', 'personalizado', 'model', 'modelo', 'budget', 'presupuesto'] }),

  // Performance (live metrics: summary only)
  e('usage.metrics', 'settings.search.usage', 'settings.search.usageHint', { summary: true, keywords: ['performance', 'rendimiento', 'ram', 'cpu', 'memory', 'memoria', 'processes', 'procesos'] }),

  // Remote
  e('remote.enable', 'remote.enable', 'remote.enableHint', { keywords: ['remote', 'remoto', 'phone', 'celular', 'movil', 'mobile', 'server', 'servidor'], toggle: { path: 'remote.enabled' } }),
  e('remote.devices', 'settings.search.remote', 'settings.search.remoteHint', { summary: true, keywords: ['qr', 'pair', 'vincular', 'device', 'dispositivo', 'port', 'puerto', 'tailscale', 'lan', 'keys', 'botones'] }),

  // Git
  e('git.chip', 'settings.git.chip', 'settings.git.chipHint', { keywords: ['git', 'branch', 'rama', 'repo', 'chip', 'diff', 'commit', 'cambios', 'changes'], toggle: { path: 'gitChip' } }),
  e('git.diag', 'settings.git.diag', 'settings.git.refreshHint', { keywords: ['git', 'path', 'version', 'detect', 'detectar'] }),

  // Updates (the status block checks on mount: summary only)
  e('updates.status', 'settings.search.updates', 'settings.search.updatesHint', { summary: true, keywords: ['update', 'actualizar', 'actualizacion', 'version', 'upgrade', 'release'] }),
  e('updates.autoCheck', 'update.autoCheck', 'update.autoCheckHint', { keywords: ['update', 'actualizar', 'startup', 'inicio'], toggle: { path: 'autoCheckUpdates' } }),

  // About
  e('about.info', 'settings.search.about', 'settings.search.aboutHint', { summary: true, keywords: ['about', 'acerca', 'version', 'license', 'licencia'] }),
]

/** Rows generated from KEY_ACTIONS: every remappable action is searchable. */
export const KEY_ENTRIES: SettingSearchEntry[] = KEY_ACTIONS.map((a) => ({
  id: `keys.${a.id}`,
  category: 'keys',
  titleKey: a.labelKey,
  keywords: ['shortcut', 'atajo', 'keybinding', 'tecla'],
}))

export const ALL_SEARCH_ENTRIES: SettingSearchEntry[] = [...SETTINGS_CATALOG, ...KEY_ENTRIES]

export function settingDomId(id: string): string {
  return 'setting-' + id.replace(/\./g, '-')
}

/** Lowercase without diacritics, one char at a time so offsets map back. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = ''
  const origin: number[] = []
  for (let i = 0; i < text.length; i++) {
    const f = text[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    for (let j = 0; j < f.length; j++) {
      folded += f[j]
      origin.push(i)
    }
  }
  return { folded, origin }
}

export function normalizeSearch(text: string): string {
  return fold(text).folded
}

export function searchTokens(query: string): string[] {
  return normalizeSearch(query).split(/\s+/).filter(Boolean)
}

/**
 * True when every token of the query appears somewhere in the haystack,
 * ignoring case and accents (NFD). An empty query matches everything.
 */
export function matchesSettingsSearch(query: string, haystack: string[]): boolean {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return true
  const hay = haystack.map(normalizeSearch).join('\n')
  return tokens.every((tok) => hay.includes(tok))
}

/** Ranges [start, end) of `text` that match a query token, merged and sorted (for <mark>). */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const tokens = searchTokens(query)
  if (!text || tokens.length === 0) return []
  const { folded, origin } = fold(text)
  const raw: Array<[number, number]> = []
  for (const tok of tokens) {
    let from = 0
    for (;;) {
      const at = folded.indexOf(tok, from)
      if (at < 0) break
      raw.push([origin[at], origin[at + tok.length - 1] + 1])
      from = at + tok.length
    }
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Array<[number, number]> = []
  for (const r of raw) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

export interface SettingsTarget {
  category: CategoryId | null
  /** Full row id ('notifications.sound'), or null for a bare category. */
  anchor: string | null
}

/** Parse an openSettings target: 'remote' or 'notifications#sound'. Unknown category = null. */
export function parseSettingsTarget(target: string | null | undefined): SettingsTarget {
  if (!target) return { category: null, anchor: null }
  const [cat, row] = target.split('#', 2)
  if (!(CATEGORY_ORDER as string[]).includes(cat)) return { category: null, anchor: null }
  return { category: cat as CategoryId, anchor: row ? `${cat}.${row}` : null }
}

type Translate = (key: MessageKey) => string

/** The strings an entry is matched against: title, description, keywords, category label. */
export function entryHaystack(entry: SettingSearchEntry, t: Translate, extra: string[] = []): string[] {
  const out = [t(entry.titleKey), t(CATEGORY_LABEL[entry.category]), ...(entry.keywords ?? []), ...extra]
  if (entry.descriptionKey) out.push(t(entry.descriptionKey))
  if (entry.groupKey) out.push(t(entry.groupKey))
  return out
}

export interface SearchGroup {
  category: CategoryId
  entries: SettingSearchEntry[]
}

/**
 * The matching entries grouped by category in nav order. `extraFor` adds
 * per-entry live strings (the current accelerator of a key row).
 */
export function searchSettings(
  query: string,
  t: Translate,
  extraFor: (entry: SettingSearchEntry) => string[] = () => [],
  entries: SettingSearchEntry[] = ALL_SEARCH_ENTRIES,
): SearchGroup[] {
  const groups: SearchGroup[] = []
  for (const category of CATEGORY_ORDER) {
    const hits = entries.filter((en) => en.category === category && matchesSettingsSearch(query, entryHaystack(en, t, extraFor(en))))
    if (hits.length > 0) groups.push({ category, entries: hits })
  }
  return groups
}

export function readSettingPath(settings: Settings, path: string): unknown {
  let cur: unknown = settings
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** A top-level patch for updateSettings that sets one nested path, cloning each level. */
export function settingsPatchForPath(settings: Settings, path: string, value: unknown): Partial<Settings> {
  const keys = path.split('.')
  const set = (obj: unknown, i: number): unknown => {
    if (i === keys.length) return value
    const base = obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>) : {}
    return { ...base, [keys[i]]: set(base[keys[i]], i + 1) }
  }
  const top = keys[0] as keyof Settings
  return { [top]: set((settings as unknown as Record<string, unknown>)[top], 1) } as Partial<Settings>
}
