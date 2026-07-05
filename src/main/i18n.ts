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
    'status.notif.done': 'Claude finished in "{pane}"',
    'status.notif.action': 'Claude needs your input in "{pane}"',
    'status.notif.generic': 'Claude stopped in "{pane}", check the console',
  },
  es: {
    'dialog.activeTitle': 'Hay consolas activas',
    'dialog.activeDetail': '{n} proceso(s) en ejecución se cerrarán.',
    'dialog.cancel': 'Cancelar',
    'dialog.closeAnyway': 'Cerrar de todos modos',
    'tray.show': 'Mostrar SnMultiCC',
    'tray.quit': 'Salir',
    'status.notif.done': 'Claude termino en "{pane}"',
    'status.notif.action': 'Claude requiere tu accion en "{pane}"',
    'status.notif.generic': 'Claude se detuvo en "{pane}", revisa la consola',
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
