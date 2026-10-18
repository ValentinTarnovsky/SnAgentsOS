import type { ConfigFile } from '@shared/types'

export type Lang = 'en' | 'es'

const MESSAGES = {
  en: {
    'dialog.activeTitle': 'Active consoles',
    'dialog.activeDetail': '{n} running process(es) will be closed.',
    'dialog.cancel': 'Cancel',
    'dialog.closeAnyway': 'Close anyway',
    'tray.show': 'Show {app}',
    'tray.quit': 'Quit',
    'tray.awake': 'Keep PC awake',
    'tray.awakeAuto': 'Auto (while agents work)',
    'tray.awakeAlways': 'Always',
    'tray.awakeNever': 'Never',
    'status.notif.test': 'Desktop notification test',
    'status.notif.done': '{provider} finished in "{pane}"',
    'status.notif.action': '{provider} needs your input in "{pane}"',
    'status.notif.generic': '{provider} stopped in "{pane}", check the console',
    'status.notif.error': '{provider} stopped with an error in "{pane}"',
    'legacy.running.title': '{legacy} is still open',
    'legacy.running.detail': 'To bring over your settings, {legacy} has to close. It will be force-closed together with its consoles; changes from the last few seconds may be lost.',
    'legacy.running.close': 'Close {legacy} and continue',
    'legacy.running.quit': 'Quit',
    'legacy.failed.title': '{legacy} could not be closed',
    'legacy.failed.detail': 'Close {legacy} yourself and try again, or quit {app}.',
    'legacy.failed.retry': 'Retry',
    'legacy.failed.quit': 'Quit',
    'pty.restarted': 'restarted {time}',
    'explorer.menuLabel': 'Open in {app}',
  },
  es: {
    'dialog.activeTitle': 'Hay consolas activas',
    'dialog.activeDetail': '{n} proceso(s) en ejecución se cerrarán.',
    'dialog.cancel': 'Cancelar',
    'dialog.closeAnyway': 'Cerrar de todos modos',
    'tray.show': 'Mostrar {app}',
    'tray.quit': 'Salir',
    'tray.awake': 'Mantener PC despierta',
    'tray.awakeAuto': 'Auto (mientras trabajan los agentes)',
    'tray.awakeAlways': 'Siempre',
    'tray.awakeNever': 'Nunca',
    'status.notif.test': 'Prueba de notificacion de escritorio',
    'status.notif.done': '{provider} terminó en "{pane}"',
    'status.notif.action': '{provider} requiere tu acción en "{pane}"',
    'status.notif.generic': '{provider} se detuvo en "{pane}", revisa la consola',
    'status.notif.error': '{provider} se detuvo por un error en "{pane}"',
    'legacy.running.title': '{legacy} sigue abierto',
    'legacy.running.detail': 'Para traer tu configuración, {legacy} se tiene que cerrar. Se va a cerrar a la fuerza junto con sus consolas; los cambios de los últimos segundos pueden perderse.',
    'legacy.running.close': 'Cerrar {legacy} y continuar',
    'legacy.running.quit': 'Salir',
    'legacy.failed.title': 'No se pudo cerrar {legacy}',
    'legacy.failed.detail': 'Cerrá {legacy} a mano y volvé a intentar, o salí de {app}.',
    'legacy.failed.retry': 'Reintentar',
    'legacy.failed.quit': 'Salir',
    'pty.restarted': 'reiniciado {time}',
    'explorer.menuLabel': 'Abrir en {app}',
  },
} as const

type MainKey = keyof (typeof MESSAGES)['en']

/** Minimal main-process translator; reads the language from the persisted config. */
export function mainT(
  cfg: ConfigFile | null,
  key: MainKey,
  vars?: Record<string, string | number>,
): string {
  return mainTLang(cfg?.settings?.language === 'es' ? 'es' : 'en', key, vars)
}

/** Local wall-clock time for short labels: 14:32 in Spanish, 2:32 PM in English. */
export function shortTime(cfg: ConfigFile | null, date: Date = new Date()): string {
  const h = date.getHours(), mm = String(date.getMinutes()).padStart(2, '0')
  if (cfg?.settings?.language === 'es') return `${String(h).padStart(2, '0')}:${mm}`
  return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`
}

/** Same, with an explicit language (the legacy dialogs run before any config of this app is loaded). */
export function mainTLang(lang: Lang, key: MainKey, vars?: Record<string, string | number>): string {
  let s: string = MESSAGES[lang][key] ?? MESSAGES.en[key]
  if (vars) s = s.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
  return s
}
