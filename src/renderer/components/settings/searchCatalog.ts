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
  | 'quick'
  | 'automation'
  | 'startup'
  | 'notifications'
  | 'keys'
  | 'data'
  | 'aiusage'
  | 'claudeaccounts'
  | 'usage'
  | 'remote'
  | 'share'
  | 'git'
  | 'labs'
  | 'updates'
  | 'about'

/**
 * Nav order (app 2.8.0): agents and their accounts and usage first, then the
 * console and its repos, then the phone, notices and connections, then the
 * general preferences, and system and info last.
 */
export const CATEGORY_ORDER: CategoryId[] = [
  'terminal',
  'agents',
  'claudeaccounts',
  'aiusage',
  'quick',
  'automation',
  'git',
  'notifications',
  'remote',
  'share',
  'connections',
  'startup',
  'appearance',
  'keys',
  'language',
  'data',
  'usage',
  'labs',
  'updates',
  'about',
]

export const CATEGORY_LABEL: Record<CategoryId, MessageKey> = {
  appearance: 'settings.cat.appearance',
  terminal: 'settings.cat.terminal',
  language: 'settings.cat.language',
  agents: 'settings.cat.agents',
  connections: 'settings.cat.connections',
  quick: 'settings.cat.quick',
  automation: 'settings.cat.automation',
  startup: 'settings.cat.startup',
  notifications: 'settings.cat.notifications',
  keys: 'settings.cat.keys',
  data: 'settings.cat.data',
  aiusage: 'settings.cat.aiusage',
  claudeaccounts: 'settings.cat.claudeaccounts',
  usage: 'settings.cat.usage',
  remote: 'settings.cat.remote',
  share: 'settings.cat.share',
  git: 'settings.cat.git',
  labs: 'settings.cat.labs',
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
  e('terminal.shellIntegration', 'settings.shellIntegration', 'settings.shellIntegrationHint', { keywords: ['powershell', 'pwsh', 'prompt', 'osc 133', 'utf-8', 'utf8', 'encoding', 'codificacion', 'marks', 'marcas'], toggle: { path: 'terminalShellIntegration' } }),
  e('terminal.persistScrollback', 'settings.persistScrollback', 'settings.persistScrollbackHint', { groupKey: 'settings.persistGroup', keywords: ['history', 'historial', 'restart', 'reinicio', 'save', 'guardar', 'scrollback', 'persist'] }),
  e('terminal.persistLines', 'settings.persistLines', undefined, { groupKey: 'settings.persistGroup', keywords: ['history', 'historial', 'lines', 'lineas', 'scrollback'] }),
  e('terminal.snapshotMode', 'settings.snapshotMode', 'settings.snapshotModeHint', { groupKey: 'settings.terminalAdvanced', keywords: ['snapshot', 'headless', 'replay', 'reattach', 'recarga', 'reload', 'avanzado', 'advanced'] }),
  // Desktop dictation (app 2.5.0: local Whisper).
  e('terminal.dictationDevice', 'settings.dictation.device', 'settings.dictation.deviceHint', { groupKey: 'settings.dictation.group', keywords: ['dictation', 'dictado', 'voice', 'voz', 'speech', 'whisper', 'gpu', 'cpu', 'cuda', 'nvidia', 'device', 'dispositivo'] }),
  e('terminal.dictationModels', 'settings.dictation.packs', 'settings.dictation.packsHint', { groupKey: 'settings.dictation.group', keywords: ['dictation', 'dictado', 'whisper', 'modelo', 'model', 'pack', 'descargar', 'download', 'gpu', 'cuda', 'visual c++', 'vc++', 'borrar', 'delete', 'privacy', 'privacidad'] }),
  e('terminal.dictationLanguage', 'settings.dictation.language', 'settings.dictation.languageHint', { groupKey: 'settings.dictation.group', keywords: ['dictation', 'dictado', 'voice', 'voz', 'language', 'idioma'] }),
  e('terminal.dictationInterim', 'settings.dictation.interim', 'settings.dictation.interimHint', { groupKey: 'settings.dictation.group', keywords: ['dictation', 'dictado', 'whisper', 'preview', 'vista previa', 'interim', 'gpu'], toggle: { path: 'dictation.interim' } }),
  e('terminal.dictationVocabulary', 'settings.dictation.vocabulary', 'settings.dictation.vocabularyHint', { groupKey: 'settings.dictation.group', keywords: ['dictation', 'dictado', 'whisper', 'vocabulary', 'vocabulario', 'words', 'palabras', 'prompt', 'terms', 'terminos'] }),
  e('terminal.dictationHeaderButton', 'settings.dictation.headerButton', 'settings.dictation.headerButtonHint', { groupKey: 'settings.dictation.group', keywords: ['dictation', 'dictado', 'microphone', 'microfono', 'mic', 'header', 'encabezado'], toggle: { path: 'dictation.headerButton' } }),

  // Agents
  e('agents.resume', 'settings.agents.resume', 'settings.agents.resumeHint', { groupKey: 'settings.agents.behavior', keywords: ['resume', 'retomar', 'session', 'sesion', 'chat', 'restart', 'reinicio'] }),
  e('agents.resumeTimeout', 'settings.agents.resumeTimeout', 'settings.agents.resumeTimeoutHint', { groupKey: 'settings.agents.behavior', keywords: ['resume', 'retomar', 'countdown', 'cuenta regresiva', 'timeout', 'dialog', 'aviso', 'modal'] }),
  e('agents.resumeNudge', 'settings.agents.resumeNudge', 'settings.agents.resumeNudgeHint', { groupKey: 'settings.agents.behavior', keywords: ['resume', 'retomar', 'nudge', 'continue', 'continuar', 'seguir'] }),
  e('agents.resumeNudgeText', 'settings.agents.resumeNudgeText', 'settings.agents.resumeNudgeTextHint', { groupKey: 'settings.agents.behavior', keywords: ['resume', 'retomar', 'nudge', 'message', 'mensaje', 'texto', 'text'] }),
  e('agents.awake', 'settings.agents.awake', 'settings.agents.awakeHint', { groupKey: 'settings.agents.behavior', keywords: ['awake', 'despierta', 'sleep', 'suspender', 'suspension', 'energy', 'energia', 'power'] }),
  e('agents.awakeDisplay', 'settings.agents.awakeDisplay', 'settings.agents.awakeDisplayHint', { groupKey: 'settings.agents.behavior', keywords: ['awake', 'despierta', 'display', 'pantalla', 'sleep', 'screen'] }),
  e('agents.rows', 'settings.agents.rows', 'settings.agents.rowsHint', { groupKey: 'settings.agents.behavior', keywords: ['rows', 'filas', 'sidebar', 'barra lateral'], toggle: { path: 'agents.sidebarAgentRows' } }),
  e('agents.sort', 'settings.agents.sort', 'settings.agents.sortHint', { groupKey: 'settings.agents.behavior', keywords: ['sort', 'orden', 'smart', 'inteligente', 'sidebar', 'barra lateral', 'workspace'] }),
  e('agents.topicAsTitle', 'settings.agents.topicAsTitle', 'settings.agents.topicAsTitleHint', { groupKey: 'settings.agents.behavior', keywords: ['topic', 'tema', 'title', 'titulo'], toggle: { path: 'agents.topicAsTitle' } }),
  e('agents.syncAgentRename', 'settings.agents.syncAgentRename', 'settings.agents.syncAgentRenameHint', { groupKey: 'settings.agents.behavior', keywords: ['rename', 'renombrar', '/rename', 'name', 'nombre', 'title', 'titulo', 'console', 'consola'], toggle: { path: 'agents.syncAgentRename' } }),
  e('agents.shellAgentDetect', 'settings.agents.shellAgentDetect', 'settings.agents.shellAgentDetectHint', { groupKey: 'settings.agents.behavior', keywords: ['powershell', 'shell', 'claude', 'codex', 'detect', 'detectar', 'agent', 'agente', 'typed', 'tipeado'], toggle: { path: 'agents.shellAgentDetect' } }),
  e('agents.ctrlDigit', 'settings.agents.ctrlDigit', 'settings.agents.ctrlDigitHint', { groupKey: 'settings.agents.behavior', keywords: ['ctrl', 'focus', 'foco', 'shortcut', 'atajo'], toggle: { path: 'agents.ctrlDigitFocus' } }),
  e('agents.hibernate', 'settings.agents.hibernate', 'settings.agents.hibernateHint', { groupKey: 'settings.agents.behavior', keywords: ['hibernate', 'hibernar', 'sleep', 'dormir', 'memory', 'memoria', 'ram', 'idle', 'inactivo'] }),
  e('agents.hibernateMinutes', 'settings.agents.hibernateMinutes', 'settings.agents.hibernateMinutesHint', { groupKey: 'settings.agents.behavior', keywords: ['hibernate', 'hibernar', 'sleep', 'dormir', 'minutes', 'minutos', 'idle', 'inactivo'] }),
  e('agents.cacheTimer', 'settings.agents.cacheTimer', 'settings.agents.cacheTimerHint', { groupKey: 'settings.agents.behavior', keywords: ['cache', 'timer', 'countdown', 'cuenta regresiva', 'claude', 'prompt'], toggle: { path: 'agents.cacheTimer.enabled' } }),
  e('agents.cacheTtl', 'settings.agents.cacheTtl', 'settings.agents.cacheTtlHint', { groupKey: 'settings.agents.behavior', keywords: ['cache', 'ttl', 'minutes', 'minutos', 'claude'] }),
  // App 2.7.0 (A6): silence watch (E10-FR-18).
  e('agents.silence', 'settings.agents.silence', 'settings.agents.silenceHint', { groupKey: 'settings.agents.behavior', keywords: ['silence', 'silencio', 'quiet', 'stalled', 'trabado', 'stuck', 'colgado', 'watchdog', 'signal', 'senal', 'chip'], toggle: { path: 'agents.silence.enabled' } }),
  e('agents.silenceQuiet', 'settings.agents.silenceQuiet', 'settings.agents.silenceQuietHint', { groupKey: 'settings.agents.behavior', keywords: ['silence', 'silencio', 'quiet', 'minutes', 'minutos', 'signal', 'senal'] }),
  e('agents.silenceStalled', 'settings.agents.silenceStalled', 'settings.agents.silenceStalledHint', { groupKey: 'settings.agents.behavior', keywords: ['silence', 'silencio', 'stalled', 'trabado', 'stuck', 'colgado', 'minutes', 'minutos'] }),
  e('agents.presets', 'settings.search.agentsPresets', 'settings.search.agentsPresetsHint', { summary: true, keywords: ['preset', 'model', 'modelo', 'agent', 'agente', 'claude', 'codex', 'command', 'comando'] }),

  // Connections, Quick Commands
  e('connections.profiles', 'settings.search.connections', 'settings.search.connectionsHint', { summary: true, keywords: ['ssh', 'connection', 'conexion', 'setup', 'login', 'password', 'contrasena', 'server', 'servidor', 'expect'] }),
  e('quick.list', 'settings.search.quick', 'settings.search.quickHint', { summary: true, keywords: ['snippet', 'snippets', 'prompt', 'comando', 'command', 'quick', 'plantilla', 'template', 'texto', 'text', 'agente', 'agent'] }),

  // Automation: pane schedules (E8-FR-29..32)
  e('automation.schedules', 'settings.search.automationSchedules', 'settings.search.automationSchedulesHint', { summary: true, keywords: ['schedule', 'programar', 'programado', 'recurring', 'recurrente', 'cron', 'automation', 'automatizacion', 'reloj', 'clock', 'diario', 'daily', 'hourly', 'cada hora'] }),
  e('automation.scheduleGrace', 'settings.automation.scheduleGrace', 'settings.automation.scheduleGraceHint', { keywords: ['missed', 'perdida', 'suspend', 'suspendida', 'apagada', 'grace', 'gracia', 'schedule', 'programar'] }),
  e('automation.scheduleMaxWait', 'settings.automation.scheduleMaxWait', 'settings.automation.scheduleMaxWaitHint', { keywords: ['busy', 'ocupado', 'wait', 'esperar', 'schedule', 'programar'] }),
  e('automation.scheduleNotify', 'settings.automation.scheduleNotify', 'settings.automation.scheduleNotifyHint', { keywords: ['notification', 'notificacion', 'schedule', 'programar', 'automation'], toggle: { path: 'automation.scheduleNotify' } }),
  // Automation: the snaos CLI (E8-FR-21/22)
  e('automation.cli', 'settings.cli.enabled', 'settings.cli.enabledHint', { keywords: ['cli', 'snaos', 'terminal', 'consola', 'command line', 'linea de comandos', 'script'], toggle: { path: 'cliEnabled' } }),
  e('automation.protectSsh', 'settings.cli.protectSsh', 'settings.cli.protectSshHint', { keywords: ['cli', 'snaos', 'ssh', 'connection', 'conexion', 'profile', 'perfil', 'protect', 'proteger'], toggle: { path: 'automation.cliProtectSsh' } }),
  e('automation.userPath', 'settings.cli.userPath', undefined, { keywords: ['cli', 'snaos', 'path', 'windows terminal', 'environment', 'entorno', 'variable'] }),
  e('automation.server', 'settings.cli.server', 'settings.cli.serverHint', { keywords: ['cli', 'snaos', 'server', 'servidor', 'pipe', 'endpoint', 'runtime'] }),
  e('automation.skill', 'settings.cli.skill', 'settings.cli.skillHint', { keywords: ['skill', 'claude', 'codex', 'snaos', 'cli', 'agent', 'agente'] }),

  // Startup
  e('startup.restoreLast', 'settings.restoreLast', undefined, { keywords: ['restore', 'restaurar', 'workspace', 'inicio', 'startup'], toggle: { path: 'restoreLastWorkspace' } }),
  e('startup.confirmClose', 'settings.confirmClose', undefined, { keywords: ['close', 'cerrar', 'confirm', 'confirmar'], toggle: { path: 'confirmCloseRunning' } }),
  e('startup.closeToTray', 'settings.closeToTray', undefined, { keywords: ['tray', 'bandeja', 'close', 'cerrar', 'minimize', 'minimizar'] }),
  e('startup.launchOnStartup', 'settings.launchOnStartup', undefined, { keywords: ['startup', 'inicio', 'login', 'windows', 'boot', 'arranque'] }),
  e('startup.globalHotkey', 'settings.globalHotkey', 'settings.globalHotkeyHint', { keywords: ['hotkey', 'shortcut', 'atajo', 'global', 'show', 'mostrar'] }),
  e('startup.explorerMenu', 'settings.explorerMenu', 'settings.explorerMenuHint', { keywords: ['explorer', 'explorador', 'context', 'contextual', 'menu', 'folder', 'carpeta', 'right click', 'clic derecho', 'open', 'abrir'] }),

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
  e('notifications.ntfy', 'notif.ntfy.title', 'notif.ntfy.desc', { keywords: ['ntfy', 'push', 'phone', 'celular', 'movil', 'topic'], toggle: { path: 'notifications.ntfy.enabled' } }),
  e('notifications.ntfyAction', 'notif.action', undefined, { groupKey: 'notif.ntfy.title', keywords: ['ntfy', 'push'], toggle: { path: 'notifications.ntfy.notifyAction', disabledUnless: ['notifications.ntfy.enabled'] } }),
  e('notifications.ntfyDone', 'notif.done', undefined, { groupKey: 'notif.ntfy.title', keywords: ['ntfy', 'push'], toggle: { path: 'notifications.ntfy.notifyDone', disabledUnless: ['notifications.ntfy.enabled'] } }),
  e('notifications.remoteDelay', 'notif.remoteDelay', 'notif.remoteDelayHint', { keywords: ['delay', 'retraso', 'demora', 'wait', 'esperar', 'seconds', 'segundos', 'phone', 'celular', 'celu', 'push', 'watch', 'reloj', 'discord', 'ntfy'] }),
  e('notifications.onlyWhenAway', 'notif.away.title', 'notif.away.desc', { keywords: ['away', 'ausente', 'idle', 'inactivo', 'locked', 'bloqueada', 'discord', 'ntfy'], toggle: { path: 'notifications.onlyWhenAway' } }),

  // Data
  e('data.backup', 'settings.search.data', 'settings.search.dataHint', { summary: true, keywords: ['data', 'datos', 'export', 'exportar', 'import', 'importar', 'backup', 'respaldo'] }),

  // Appearance, language
  e('appearance.theme', 'settings.theme', 'settings.themeHint', { keywords: ['theme', 'tema', 'color', 'dark', 'oscuro', 'light', 'claro'] }),
  e('appearance.customColors', 'settings.customColors', 'settings.customColorsHint', { keywords: ['color', 'custom', 'personalizado', 'palette'] }),
  e('appearance.sidebarAgentsBoard', 'settings.sidebarBlocks.agentsBoard', undefined, { groupKey: 'settings.sidebarBlocks.group', keywords: ['sidebar', 'barra lateral', 'hide', 'ocultar', 'show', 'mostrar', 'board', 'tablero', 'agents', 'agentes'], toggle: { path: 'sidebarBlocks.agentsBoard' } }),
  e('appearance.sidebarTeams', 'settings.sidebarBlocks.teams', 'settings.sidebarBlocks.teamsHint', { groupKey: 'settings.sidebarBlocks.group', keywords: ['sidebar', 'barra lateral', 'hide', 'ocultar', 'show', 'mostrar', 'teams', 'equipos'], toggle: { path: 'sidebarBlocks.teams' } }),
  e('appearance.sidebarSharedWithMe', 'settings.sidebarBlocks.sharedWithMe', undefined, { groupKey: 'settings.sidebarBlocks.group', keywords: ['sidebar', 'barra lateral', 'hide', 'ocultar', 'show', 'mostrar', 'shared', 'compartido', 'share'], toggle: { path: 'sidebarBlocks.sharedWithMe' } }),
  e('appearance.sidebarShareIndicator', 'settings.sidebarBlocks.shareIndicator', undefined, { groupKey: 'settings.sidebarBlocks.group', keywords: ['sidebar', 'barra lateral', 'hide', 'ocultar', 'show', 'mostrar', 'share', 'compartir', 'indicator', 'indicador'], toggle: { path: 'sidebarBlocks.shareIndicator' } }),
  e('appearance.sidebarRemoteIndicator', 'settings.sidebarBlocks.remoteIndicator', undefined, { groupKey: 'settings.sidebarBlocks.group', keywords: ['sidebar', 'barra lateral', 'hide', 'ocultar', 'show', 'mostrar', 'remote', 'remoto', 'phone', 'celular', 'indicator', 'indicador'], toggle: { path: 'sidebarBlocks.remoteIndicator' } }),
  e('appearance.sidebarUsageBars', 'settings.sidebarBlocks.usageBars', 'settings.sidebarBlocks.usageBarsHint', { groupKey: 'settings.sidebarBlocks.group', keywords: ['sidebar', 'barra lateral', 'hide', 'ocultar', 'show', 'mostrar', 'usage', 'uso', 'bars', 'barras', 'quota', 'cuota', 'limits', 'limites'], toggle: { path: 'sidebarBlocks.usageBars' } }),
  e('language.language', 'settings.language', 'settings.languageHint', { keywords: ['language', 'idioma', 'english', 'ingles', 'espanol', 'spanish'] }),

  // AI usage
  e('aiusage.enable', 'aiusage.enable', 'aiusage.enableHint', { keywords: ['usage', 'uso', 'tokens', 'limit', 'limite', 'quota', 'cuota', 'bars', 'barras'], toggle: { path: 'usage.enabled' } }),
  e('aiusage.showStatus', 'aiusage.showStatus', 'aiusage.showStatusHint', { keywords: ['status', 'estado', 'anthropic'], toggle: { path: 'usage.showStatus', disabledUnless: ['usage.enabled'] } }),
  e('aiusage.refreshOnFocus', 'aiusage.refreshOnFocus', 'aiusage.refreshOnFocusHint', { keywords: ['refresh', 'actualizar', 'interval', 'intervalo'], toggle: { path: 'usage.refreshOnFocus', disabledUnless: ['usage.enabled'] } }),
  e('aiusage.custom', 'aiusage.customTitle', 'aiusage.customHint', { keywords: ['custom', 'personalizado', 'model', 'modelo', 'budget', 'presupuesto'] }),

  // Claude accounts (app 2.3.0). No inline switch for the automatic toggle: the terms note sits next to the live row.
  e('claudeaccounts.accounts', 'claudeaccounts.title', 'claudeaccounts.hint', { summary: true, keywords: ['account', 'accounts', 'cuenta', 'cuentas', 'login', 'claude', 'switch', 'cambiar', 'subscription', 'suscripcion', 'primary', 'principal', 'secondary', 'secundaria', 'priority', 'prioridad', 'order', 'orden'] }),
  e('claudeaccounts.auto', 'claudeaccounts.auto', 'claudeaccounts.autoHint', { keywords: ['account', 'cuenta', 'automatic', 'automatico', 'switch', 'cambiar', 'limit', 'limite', 'claude'] }),
  e('claudeaccounts.switchAt', 'claudeaccounts.switchAt', 'claudeaccounts.switchAtHint', { keywords: ['account', 'cuenta', 'threshold', 'umbral', 'percent', 'porcentaje', 'limit', 'limite'] }),
  e('claudeaccounts.return', 'claudeaccounts.return', 'claudeaccounts.returnHint', { keywords: ['account', 'cuenta', 'primary', 'principal', 'priority', 'prioridad', 'return', 'volver', 'reset'] }),
  e('claudeaccounts.defer', 'claudeaccounts.defer', 'claudeaccounts.deferHint', { keywords: ['account', 'cuenta', 'working', 'trabajando', 'wait', 'esperar'] }),
  e('claudeaccounts.pollParked', 'claudeaccounts.pollParked', 'claudeaccounts.pollParkedHint', { keywords: ['account', 'cuenta', 'usage', 'uso', 'parked'] }),
  e('claudeaccounts.alertOnSwitch', 'claudeaccounts.alertOnSwitch', 'claudeaccounts.alertOnSwitchHint', { keywords: ['account', 'cuenta', 'alert', 'alerta', 'aviso'] }),

  // Performance (live metrics: summary only)
  e('usage.metrics', 'settings.search.usage', 'settings.search.usageHint', { summary: true, keywords: ['performance', 'rendimiento', 'ram', 'cpu', 'memory', 'memoria', 'processes', 'procesos'] }),

  // Remote
  e('remote.enable', 'remote.enable', 'remote.enableHint', { keywords: ['remote', 'remoto', 'phone', 'celular', 'movil', 'mobile', 'server', 'servidor'], toggle: { path: 'remote.enabled' } }),
  e('remote.secure', 'remote.secure', 'remote.secureHint', { keywords: ['https', 'secure', 'seguro', 'tailscale', 'serve', 'push', 'pwa', 'certificate', 'certificado'] }),
  e('remote.phoneFit', 'remote.phoneFit', 'remote.phoneFitHint', { keywords: ['phone', 'celular', 'fit', 'ajustar', 'size', 'tamano', 'columns', 'columnas', 'mobile'], toggle: { path: 'remote.phoneFit' } }),
  e('remote.devices', 'settings.search.remote', 'settings.search.remoteHint', { summary: true, keywords: ['qr', 'pair', 'vincular', 'device', 'dispositivo', 'port', 'puerto', 'tailscale', 'lan', 'keys', 'botones'] }),

  // Sharing (app 2.4.0, item 8): the grants and guests block is live data, summary only. Pause all is main state, not a setting.
  e('share.enable', 'shareHost.settings.enable', 'shareHost.settings.enableHint', { keywords: ['share', 'compartir', 'guest', 'invitado', 'host', 'anfitrion', 'tunnel', 'tunel', 'pc'], toggle: { path: 'share.enabled' } }),
  e('share.pauseAll', 'shareHost.settings.pauseAll', 'shareHost.settings.pauseAllHint', { keywords: ['share', 'compartir', 'pause', 'pausar', 'guest', 'invitado'] }),
  e('share.port', 'shareHost.settings.port', 'shareHost.settings.portHint', { keywords: ['share', 'compartir', 'port', 'puerto', 'firewall', 'tailscale', 'lan'] }),
  e('share.guestName', 'shareHost.settings.guestName', 'shareHost.settings.guestNameHint', { keywords: ['share', 'compartir', 'name', 'nombre', 'guest', 'invitado'] }),
  e('share.defaultPerm', 'shareHost.settings.defaultPerm', 'shareHost.settings.defaultPermHint', { keywords: ['share', 'compartir', 'permission', 'permiso', 'view', 'ver', 'type', 'escribir', 'full', 'total'] }),
  e('share.grants', 'settings.search.share', 'settings.search.shareHint', { summary: true, keywords: ['share', 'compartir', 'invite', 'invitacion', 'password', 'contrasena', 'revoke', 'revocar', 'guest', 'invitado', 'disconnect', 'desconectar', 'expiry', 'vencimiento'] }),

  // Git
  e('git.chip', 'settings.git.chip', 'settings.git.chipHint', { keywords: ['git', 'branch', 'rama', 'repo', 'chip', 'diff', 'commit', 'cambios', 'changes'], toggle: { path: 'gitChip' } }),
  e('git.diag', 'settings.git.diag', 'settings.git.refreshHint', { keywords: ['git', 'path', 'version', 'detect', 'detectar'] }),
  e('git.worktreesRoot', 'settings.git.worktreesRoot', 'settings.git.worktreesRootHint', { keywords: ['worktree', 'worktrees', 'root', 'raiz', 'carpeta', 'folder', 'branch', 'rama'] }),
  e('git.worktrees', 'settings.git.worktrees', 'settings.git.worktreesHint', { keywords: ['worktree', 'worktrees', 'orphan', 'huerfano', 'huerfanos', 'branch', 'rama', 'borrar', 'delete'] }),

  // Labs (app 2.7.0): opt-in experimental modules, off by default (plain booleans, inline switches).
  e('labs.consoleChat', 'labs.consoleChat', 'labs.consoleChatHint', { keywords: ['labs', 'experimental', 'beta', 'chat', 'console', 'consola', 'messages', 'mensajes', 'conversation', 'conversacion'], toggle: { path: 'labs.consoleChat' } }),
  e('labs.teams', 'labs.teams', 'labs.teamsHint', { keywords: ['labs', 'experimental', 'beta', 'teams', 'team', 'equipos', 'equipo', 'agents', 'agentes', 'roles', 'board', 'tablero', 'tasks', 'tareas'], toggle: { path: 'labs.teams' } }),

  // Updates (the status block checks on mount: summary only)
  e('updates.status', 'settings.search.updates', 'settings.search.updatesHint', { summary: true, keywords: ['update', 'actualizar', 'actualizacion', 'version', 'upgrade', 'release'] }),
  e('updates.autoCheck', 'update.autoCheck', 'update.autoCheckHint', { keywords: ['update', 'actualizar', 'startup', 'inicio'], toggle: { path: 'autoCheckUpdates' } }),

  // About
  e('about.info', 'settings.search.about', 'settings.search.aboutHint', { summary: true, keywords: ['about', 'acerca', 'version', 'license', 'licencia', 'diagnostics', 'diagnostico', 'crash'] }),
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
  const [raw, row] = target.split('#', 2)
  // The category was 'snippets' before Quick Commands (E8-FR-03): old links still land.
  const cat = raw === 'snippets' ? 'quick' : raw
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
