/**
 * Tiny flat i18n for the phone client, mirroring the renderer's approach. The
 * active language comes from the desktop state snapshot (authOk / state), so the
 * phone follows whatever language the desktop is set to; setLang() is called by
 * the store whenever a snapshot arrives.
 */
import type { Language } from '@shared/types'

type Vars = Record<string, string | number>

const en = {
  // Welcome / pairing
  'welcome.title': 'SnMultiCC Remote',
  'welcome.body': 'Open Settings > Remote control on the desktop and scan the QR code to connect this phone.',
  'pair.title': 'Pair this device',
  'pair.nameLabel': 'Device name',
  'pair.namePlaceholder': 'My phone',
  'pair.connect': 'Connect',
  'pair.pending': 'Approve on your desktop',
  'pair.pendingBody': 'A prompt is waiting on the desktop. Approve it to finish pairing.',
  'pair.denied': 'Pairing was denied',
  'pair.expired': 'Approval timed out',
  'pair.badCode': 'Invalid or expired code',
  'pair.limit': 'Device limit reached',
  'pair.rescan': 'Scan the QR again from the desktop to retry.',
  'pair.noCode': 'No pairing code. Scan the QR from the desktop.',
  // In-app scanner
  'welcome.link': 'Link this phone',
  'scan.title': 'Scan the QR code',
  'scan.aim': 'Point the camera at the QR in Settings > Remote control on the desktop.',
  'scan.photoHint': 'The camera will open. Take a photo of the QR shown on the desktop.',
  'scan.openCamera': 'Take a photo of the QR',
  'scan.reading': 'Reading photo...',
  'scan.noQr': 'No QR found in the photo. Get closer and try again.',
  'scan.camDenied': 'Camera unavailable. Take a photo or type the code instead.',
  'scan.manualLabel': 'or type the 8-character code',
  'scan.continue': 'Go',
  // Auth / connection
  'conn.connecting': 'Connecting...',
  'conn.reconnecting': 'Reconnecting...',
  'conn.attempt': 'Attempt {n}',
  'conn.desktopGone': 'Desktop closed - waiting for it to come back',
  'conn.disabled': 'Remote control was turned off on the desktop',
  'conn.impostor': 'Security check failed',
  'conn.impostorBody': 'The server could not prove it knows this device. Connection aborted.',
  'conn.locked': 'Too many attempts',
  'conn.lockedBody': 'Try again in {s}s.',
  'conn.rePair': 'This device needs to be paired again',
  'conn.rePairBody': 'Scan the QR from the desktop to re-pair.',
  'conn.revoked': 'This device was removed',
  'conn.revokedBody': 'Access was revoked on the desktop. Scan the QR to pair again.',
  'conn.retry': 'Retry',
  // Main UI
  'main.noConsole': 'No console selected',
  'main.consoles': 'Consoles',
  'main.workspaces': 'Workspaces',
  'main.actions': 'Actions',
  'main.running': 'running',
  'main.stopped': 'stopped',
  'main.starting': 'starting...',
  // Key bar
  'key.esc': 'Esc',
  'key.tab': 'Tab',
  'key.ctrl': 'Ctrl',
  'key.enter': 'Enter',
  'key.paste': 'Paste',
  'key.keyboard': 'Keyboard',
  // Action sheet
  'act.newConsole': 'New console',
  'act.restart': 'Restart console',
  'act.close': 'Close console',
  'act.globalPrompt': 'Global prompt',
  'act.settings': 'Settings',
  'act.send': 'Send',
  'act.cancel': 'Cancel',
  'act.confirm': 'Confirm',
  'act.restartConfirm': 'Restart this console? Its running process will be killed.',
  'act.closeConfirm': 'Close this console? Its running process will be killed.',
  'act.promptPlaceholder': 'Prompt sent to every console in this workspace',
  'act.promptSent': 'Sent to {n} console(s)',
  'act.pasteLabel': 'Paste text into the console',
  'act.pastePlaceholder': 'Type or paste here, then Paste',
  'act.fontSize': 'Font size',
  'act.unpair': 'Unpair this device',
  'act.unpairConfirm': 'Forget this device? You will need to scan the QR to pair again.',
} as const

type Key = keyof typeof en

const es: Record<Key, string> = {
  'welcome.title': 'SnMultiCC Remoto',
  'welcome.body': 'Abri Ajustes > Control remoto en la PC y escanea el codigo QR para conectar este telefono.',
  'pair.title': 'Vincular este dispositivo',
  'pair.nameLabel': 'Nombre del dispositivo',
  'pair.namePlaceholder': 'Mi telefono',
  'pair.connect': 'Conectar',
  'pair.pending': 'Aproba en tu PC',
  'pair.pendingBody': 'Hay un aviso esperando en la PC. Aprobalo para terminar la vinculacion.',
  'pair.denied': 'La vinculacion fue denegada',
  'pair.expired': 'Se agoto el tiempo de aprobacion',
  'pair.badCode': 'Codigo invalido o expirado',
  'pair.limit': 'Se alcanzo el limite de dispositivos',
  'pair.rescan': 'Escanea el QR de nuevo desde la PC para reintentar.',
  'pair.noCode': 'Sin codigo de vinculacion. Escanea el QR desde la PC.',
  'welcome.link': 'Vincular este telefono',
  'scan.title': 'Escanear el codigo QR',
  'scan.aim': 'Apunta la camara al QR de Ajustes > Control remoto en la PC.',
  'scan.photoHint': 'Se va a abrir la camara. Sacale una foto al QR que muestra la PC.',
  'scan.openCamera': 'Sacar foto al QR',
  'scan.reading': 'Leyendo la foto...',
  'scan.noQr': 'No se encontro un QR en la foto. Acercate y proba de nuevo.',
  'scan.camDenied': 'Camara no disponible. Saca una foto o escribi el codigo.',
  'scan.manualLabel': 'o escribi el codigo de 8 caracteres',
  'scan.continue': 'Ir',
  'conn.connecting': 'Conectando...',
  'conn.reconnecting': 'Reconectando...',
  'conn.attempt': 'Intento {n}',
  'conn.desktopGone': 'La PC se cerro - esperando a que vuelva',
  'conn.disabled': 'El control remoto se apago en la PC',
  'conn.impostor': 'Fallo la verificacion de seguridad',
  'conn.impostorBody': 'El servidor no pudo probar que conoce este dispositivo. Conexion abortada.',
  'conn.locked': 'Demasiados intentos',
  'conn.lockedBody': 'Proba de nuevo en {s}s.',
  'conn.rePair': 'Este dispositivo necesita vincularse otra vez',
  'conn.rePairBody': 'Escanea el QR desde la PC para volver a vincular.',
  'conn.revoked': 'Este dispositivo fue eliminado',
  'conn.revokedBody': 'El acceso fue revocado en la PC. Escanea el QR para vincular de nuevo.',
  'conn.retry': 'Reintentar',
  'main.noConsole': 'Ninguna consola seleccionada',
  'main.consoles': 'Consolas',
  'main.workspaces': 'Espacios',
  'main.actions': 'Acciones',
  'main.running': 'activa',
  'main.stopped': 'detenida',
  'main.starting': 'iniciando...',
  'key.esc': 'Esc',
  'key.tab': 'Tab',
  'key.ctrl': 'Ctrl',
  'key.enter': 'Enter',
  'key.paste': 'Pegar',
  'key.keyboard': 'Teclado',
  'act.newConsole': 'Nueva consola',
  'act.restart': 'Reiniciar consola',
  'act.close': 'Cerrar consola',
  'act.globalPrompt': 'Prompt global',
  'act.settings': 'Ajustes',
  'act.send': 'Enviar',
  'act.cancel': 'Cancelar',
  'act.confirm': 'Confirmar',
  'act.restartConfirm': 'Reiniciar esta consola? Su proceso en ejecucion sera terminado.',
  'act.closeConfirm': 'Cerrar esta consola? Su proceso en ejecucion sera terminado.',
  'act.promptPlaceholder': 'Prompt enviado a cada consola de este espacio',
  'act.promptSent': 'Enviado a {n} consola(s)',
  'act.pasteLabel': 'Pegar texto en la consola',
  'act.pastePlaceholder': 'Escribi o pega aca, despues Pegar',
  'act.fontSize': 'Tamano de fuente',
  'act.unpair': 'Desvincular este dispositivo',
  'act.unpairConfirm': 'Olvidar este dispositivo? Vas a tener que escanear el QR para vincular otra vez.',
}

const DICTS: Record<Language, Record<Key, string>> = { en, es }

let current: Language = 'en'

/** Set the active language (called when a desktop snapshot arrives). */
export function setLang(lang: Language): void {
  current = lang
}

/** Current active language. */
export function getLang(): Language {
  return current
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}

/** Translate a key with optional interpolation vars, falling back to English. */
export function t(key: Key, vars?: Vars): string {
  const dict = DICTS[current] ?? en
  return interpolate(dict[key] ?? en[key] ?? key, vars)
}

export type MobileMessageKey = Key
