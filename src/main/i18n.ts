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
    'status.notif.done': '{provider} finished its turn in "{pane}"',
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
    'pty.historyRestored': 'restarted - history from {date}',
    // Crash resilience dialogs (E4-FR-21, 25).
    'crash.breaker.message': '{app} could not recover the window.',
    'crash.breaker.detailNone': 'No consoles are running.',
    'crash.breaker.detailOne': 'Your console keeps running in the background.',
    'crash.breaker.detailMany': 'Your {n} consoles keep running in the background.',
    'crash.retry': 'Retry',
    'crash.copy': 'Copy diagnostics',
    'crash.background': 'Leave in background',
    'crash.closeNone': 'Close {app}',
    'crash.closeOne': 'Close {app} (closes 1 console)',
    'crash.closeMany': 'Close {app} (closes {n} consoles)',
    'crash.hang.message': '{app} is not responding',
    'crash.hang.detail': 'The window has not responded for more than 15 seconds. Your consoles keep running.',
    'crash.wait': 'Wait',
    'crash.reload': 'Reload window',
    'explorer.menuLabel': 'Open in {app}',
    // Remote channels, Discord and ntfy (E2-FR-40): the reason only, never reply text.
    'status.push.permission': 'Permission requested',
    'status.push.question': 'Question pending',
    'status.push.plan': 'Plan approval requested',
    'status.push.elicitation': 'MCP response requested',
    'status.push.failure': 'Agent stopped with an error',
    'status.push.done': 'Turn complete',
    'status.push.test': 'ntfy notification test',
    // Web Push titles (E3-FR-45): agent and reason only, never reply text.
    'webpush.permission': '{agent} needs permission',
    'webpush.question': '{agent} has a question',
    'webpush.plan': '{agent} wants a plan approved',
    'webpush.elicitation': '{agent} needs an answer',
    'webpush.done': '{agent} finished',
    'webpush.failure': '{agent} failed',
    // Share host (app 2.4.0, item 8): the guest's name as the host sees it.
    'share.guestFallback': 'Guest',
    'share.guestLabel': '{name} (guest)',
    'share.joinTitle': 'Share request',
    'share.joinBody': '{name} ({ip}) wants to join "{scope}"',
    // Claude multi-account notices (app 2.3.0; N accounts in 2.4.0): labels or "Account N" only, never an email.
    'accounts.accountN': 'Account {n}',
    'accounts.unknownName': 'another account',
    'accounts.window.5h': '5-hour',
    'accounts.window.7d': 'weekly',
    'accounts.switched.title': 'Claude account switched',
    'accounts.switched.auto': 'Now using {to}: {from} reached {percent}% of its {window} limit',
    'accounts.switched.return': 'Back to {to} after its limit reset',
    'accounts.allExhausted.title': 'Claude accounts at their limit',
    'accounts.allExhausted': 'Every Claude account is at its limit; staying on {active}',
    'accounts.unknown.title': 'Unsaved Claude login',
    'accounts.unknown': 'Claude is signed in with an account that is not saved. Automatic switching is paused.',
    'accounts.conflict.title': 'Claude account conflict',
    'accounts.conflict': 'A Claude console refreshed {account} after the switch. Automatic switching is paused.',
    'accounts.rollback.title': 'Claude account restored',
    'accounts.rollback': '{failed} could not renew its login, so {to} is back in use. Capture {failed} again. Automatic switching is paused.',
    'accounts.locked.title': 'Claude login locked',
    'accounts.locked': 'A saved Claude login cannot be opened on this PC or user. Capture it again. Automatic switching is paused.',
    'accounts.loggedOut.title': 'Claude is signed out',
    'accounts.loggedOut': '{account} is no longer signed in to Claude (its login could not be renewed, or it signed out). Sign in again and capture it.',
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
    'status.notif.done': '{provider} terminó su turno en "{pane}"',
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
    'pty.historyRestored': 'reiniciado - historial del {date}',
    'crash.breaker.message': '{app} no pudo recuperar la ventana.',
    'crash.breaker.detailNone': 'No hay consolas en ejecución.',
    'crash.breaker.detailOne': 'Tu consola sigue corriendo en segundo plano.',
    'crash.breaker.detailMany': 'Tus {n} consolas siguen corriendo en segundo plano.',
    'crash.retry': 'Reintentar',
    'crash.copy': 'Copiar diagnóstico',
    'crash.background': 'Dejar en segundo plano',
    'crash.closeNone': 'Cerrar {app}',
    'crash.closeOne': 'Cerrar {app} (cierra 1 consola)',
    'crash.closeMany': 'Cerrar {app} (cierra {n} consolas)',
    'crash.hang.message': '{app} no responde',
    'crash.hang.detail': 'La ventana no responde hace más de 15 segundos. Tus consolas siguen corriendo.',
    'crash.wait': 'Esperar',
    'crash.reload': 'Recargar ventana',
    'explorer.menuLabel': 'Abrir en {app}',
    'status.push.permission': 'Permiso pendiente',
    'status.push.question': 'Pregunta pendiente',
    'status.push.plan': 'Plan para aprobar',
    'status.push.elicitation': 'Respuesta MCP pendiente',
    'status.push.failure': 'El agente se detuvo por un error',
    'status.push.done': 'Turno terminado',
    'status.push.test': 'Prueba de notificación de ntfy',
    'webpush.permission': '{agent} necesita permiso',
    'webpush.question': '{agent} tiene una pregunta',
    'webpush.plan': '{agent} espera que apruebes un plan',
    'webpush.elicitation': '{agent} necesita una respuesta',
    'webpush.done': '{agent} terminó',
    'webpush.failure': '{agent} falló',
    'share.guestFallback': 'Invitado',
    'share.guestLabel': '{name} (invitado)',
    'share.joinTitle': 'Pedido para compartir',
    'share.joinBody': '{name} ({ip}) quiere unirse a "{scope}"',
    'accounts.accountN': 'Cuenta {n}',
    'accounts.unknownName': 'otra cuenta',
    'accounts.window.5h': 'de 5 horas',
    'accounts.window.7d': 'semanal',
    'accounts.switched.title': 'Cambió la cuenta de Claude',
    'accounts.switched.auto': 'Ahora se usa {to}: {from} llegó al {percent}% de su límite {window}',
    'accounts.switched.return': 'De vuelta en {to}: su límite se reinició',
    'accounts.allExhausted.title': 'Cuentas de Claude en el límite',
    'accounts.allExhausted': 'Todas las cuentas de Claude están en su límite; se sigue con {active}',
    'accounts.unknown.title': 'Login de Claude sin guardar',
    'accounts.unknown': 'Claude tiene abierta una cuenta que no está guardada. El cambio automático quedó en pausa.',
    'accounts.conflict.title': 'Conflicto de cuentas de Claude',
    'accounts.conflict': 'Una consola de Claude renovó {account} después del cambio. El cambio automático quedó en pausa.',
    'accounts.rollback.title': 'Se restauró la cuenta de Claude',
    'accounts.rollback': '{failed} no pudo renovar su login, así que se volvió a {to}. Capturá {failed} de nuevo. El cambio automático quedó en pausa.',
    'accounts.locked.title': 'Login de Claude bloqueado',
    'accounts.locked': 'Un login guardado de Claude no se puede abrir en esta PC o usuario. Capturalo de nuevo. El cambio automático quedó en pausa.',
    'accounts.loggedOut.title': 'Claude quedó sin sesión',
    'accounts.loggedOut': '{account} ya no tiene sesión en Claude (no pudo renovar su login, o se cerró la sesión). Iniciá sesión de nuevo y capturala.',
  },
} as const

export type MainKey = keyof (typeof MESSAGES)['en']

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

/**
 * Short local date + time of a saved history (E6-FR-11): 17/10 14:32 in
 * Spanish, 10/17 2:32 PM in English.
 */
export function shortDateTime(cfg: ConfigFile | null, date: Date): string {
  const d = date.getDate(), m = date.getMonth() + 1
  const day = cfg?.settings?.language === 'es' ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}` : `${m}/${d}`
  return `${day} ${shortTime(cfg, date)}`
}

/** Same, with an explicit language (the legacy dialogs run before any config of this app is loaded). */
export function mainTLang(lang: Lang, key: MainKey, vars?: Record<string, string | number>): string {
  let s: string = MESSAGES[lang][key] ?? MESSAGES.en[key]
  if (vars) s = s.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
  return s
}
