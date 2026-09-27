import type { ConfigFile } from '@shared/types'

type Lang = 'en' | 'es'

const MESSAGES = {
  en: {
    'dialog.activeTitle': 'Active consoles',
    'dialog.activeDetail': '{n} running process(es) will be closed.',
    'dialog.cancel': 'Cancel',
    'dialog.closeAnyway': 'Close anyway',
    'tray.show': 'Show SnMultiCC',
    'tray.quit': 'Quit',
    'status.notif.test': 'Desktop notification test',
    'status.notif.done': '{provider} finished in "{pane}"',
    'status.notif.action': '{provider} needs your input in "{pane}"',
    'status.notif.generic': '{provider} stopped in "{pane}", check the console',
    'status.notif.error': '{provider} stopped with an error in "{pane}"',
  },
  es: {
    'dialog.activeTitle': 'Hay consolas activas',
    'dialog.activeDetail': '{n} proceso(s) en ejecución se cerrarán.',
    'dialog.cancel': 'Cancelar',
    'dialog.closeAnyway': 'Cerrar de todos modos',
    'tray.show': 'Mostrar SnMultiCC',
    'tray.quit': 'Salir',
    'status.notif.test': 'Prueba de notificacion de escritorio',
    'status.notif.done': '{provider} terminó en "{pane}"',
    'status.notif.action': '{provider} requiere tu acción en "{pane}"',
    'status.notif.generic': '{provider} se detuvo en "{pane}", revisa la consola',
    'status.notif.error': '{provider} se detuvo por un error en "{pane}"',
  },
} as const

type MainKey = keyof (typeof MESSAGES)['en']

/** Minimal main-process translator; reads the language from the persisted config. */
export function mainT(
  cfg: ConfigFile | null,
  key: MainKey,
  vars?: Record<string, string | number>,
): string {
  const lang: Lang = cfg?.settings?.language === 'es' ? 'es' : 'en'
  let s: string = MESSAGES[lang][key] ?? MESSAGES.en[key]
  if (vars) s = s.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
  return s
}
