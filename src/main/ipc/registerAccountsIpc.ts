import { ipcMain } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/ipc-channels'
import { ACCOUNT_ID_RE, ACCOUNT_LABEL_MAX, normalizeAccountsSettings, type AccountsOpRes } from '@shared/claude-accounts'
import type { AccountService } from '../accounts/AccountService'

/**
 * accounts:* (app 2.3.0). Every payload is checked here; the renderer may
 * only claim the `manual` and `phone` reasons (never `auto_*` or `cli`), and
 * an id must match ACCOUNT_ID_RE. Nothing that crosses carries a token.
 */
const accountId = z.string().regex(ACCOUNT_ID_RE)
const role = z.enum(['primary', 'secondary'])
const captureReq = z.object({ role, label: z.string().max(200).optional(), replace: z.boolean().optional() })
const switchReq = z.object({ target: z.union([role, accountId]), reason: z.enum(['manual', 'phone']) })
const idReq = z.object({ id: accountId })
const renameReq = z.object({ id: accountId, label: z.string().max(ACCOUNT_LABEL_MAX * 4) })

export function registerAccountsIpc(svc: AccountService): void {
  const bad = (): AccountsOpRes => ({ ok: false, error: 'bad_request', state: svc.status() })

  ipcMain.handle(CH.ACCOUNTS_GET_STATE, () => svc.status())
  ipcMain.handle(CH.ACCOUNTS_CAPTURE, (_e, raw: unknown) => {
    const p = captureReq.safeParse(raw)
    return p.success ? svc.capture(p.data.role, { label: p.data.label, replace: p.data.replace }) : bad()
  })
  ipcMain.handle(CH.ACCOUNTS_SWITCH, (_e, raw: unknown) => {
    const p = switchReq.safeParse(raw)
    return p.success ? svc.switchTo(p.data.target, p.data.reason) : bad()
  })
  ipcMain.handle(CH.ACCOUNTS_REMOVE, (_e, raw: unknown) => {
    const p = idReq.safeParse(raw)
    return p.success ? svc.remove(p.data.id) : bad()
  })
  ipcMain.handle(CH.ACCOUNTS_RENAME, (_e, raw: unknown) => {
    const p = renameReq.safeParse(raw)
    return p.success ? svc.rename(p.data.id, p.data.label) : bad()
  })
  ipcMain.handle(CH.ACCOUNTS_SET_PRIMARY, (_e, raw: unknown) => {
    const p = idReq.safeParse(raw)
    return p.success ? svc.setPrimary(p.data.id) : bad()
  })
  ipcMain.handle(CH.ACCOUNTS_RESUME_AUTO, () => svc.resumeAuto())
  ipcMain.on(CH.ACCOUNTS_SET_CONFIG, (_e, raw: unknown) => {
    if (raw && typeof raw === 'object') svc.setConfig(normalizeAccountsSettings(raw as Record<string, unknown>))
  })
}
