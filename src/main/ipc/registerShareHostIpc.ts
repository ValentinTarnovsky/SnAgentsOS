/**
 * Share host IPC (app 2.4.0, item 8): thin wiring between snApi.share.host
 * and ShareHost. The renderer only ever names grants, sessions and requests
 * by id; scopes are resolved against main's own snapshot, and every argument
 * is checked in ShareHost before it acts. The password crosses IPC once
 * (`share:setPassword` / `share:create`) and is never persisted, only its
 * scrypt key sealed by DPAPI.
 *
 * The firewall row of the Share dialog runs a second FirewallService on the
 * share port with its own rule names (`<product>.Share.TCP` / `.Share.Tailnet`,
 * DisplayName "<product> Share ..."), so fixing one never touches the phone
 * server's rules.
 */
import { app, ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  FirewallFixRes,
  FirewallStatus,
  ShareCreateReq,
  ShareCreateRes,
  ShareHostConfig,
  ShareHostState,
  ShareInviteRes,
  ShareOpRes,
  ShareResolveReq,
  ShareUpdateReq,
} from '@shared/ipc-contract'
import type { ShareHost } from '../share/ShareHost'
import { FW_RULES_SHARE, FirewallService } from '../remote/firewall'
import { listEndpoints } from '../remote/network'
import { isPortable } from '../paths'
import { runPowerShell } from './registerRemoteIpc'

export function registerShareHostIpc(host: ShareHost): void {
  const firewall = new FirewallService({
    platform: process.platform,
    exe: () => app.getPath('exe'),
    port: () => host.port,
    programScope: () => app.isPackaged && !isPortable(),
    endpoints: listEndpoints,
    run: runPowerShell,
    now: () => Date.now(),
    rules: FW_RULES_SHARE,
  })

  ipcMain.handle(CH.SHARE_HOST_STATE, (): ShareHostState => host.hostState())
  ipcMain.handle(CH.SHARE_CREATE, (_e, req: ShareCreateReq): Promise<ShareCreateRes> => host.create(req))
  ipcMain.handle(CH.SHARE_INVITE, (_e, grantId: unknown): ShareInviteRes => host.invite(grantId))
  ipcMain.handle(CH.SHARE_ROTATE, (_e, grantId: unknown): ShareInviteRes => host.rotate(grantId))
  ipcMain.handle(CH.SHARE_UPDATE, (_e, req: ShareUpdateReq): ShareOpRes => host.update(req))
  ipcMain.handle(CH.SHARE_SET_PASSWORD, (_e, req: unknown): Promise<ShareOpRes> => {
    const r = (req && typeof req === 'object' ? req : {}) as { grantId?: unknown; password?: unknown }
    return host.setPassword(r.grantId, r.password === null ? null : r.password)
  })
  ipcMain.handle(CH.SHARE_REVOKE, (_e, grantId: unknown): ShareOpRes => host.revoke(grantId))
  ipcMain.handle(CH.SHARE_KICK, (_e, sessionId: unknown): ShareOpRes => host.kick(sessionId))
  ipcMain.handle(CH.SHARE_SESSION_PERM, (_e, req: unknown): ShareOpRes => {
    const r = (req && typeof req === 'object' ? req : {}) as { sessionId?: unknown; perm?: unknown }
    return host.sessionPerm(r.sessionId, r.perm)
  })
  ipcMain.handle(CH.SHARE_PAUSE_ALL, (_e, on: unknown): ShareOpRes => host.pauseAll(on === true))
  ipcMain.on(CH.SHARE_RESOLVE, (_e, req: ShareResolveReq) => host.resolve(req))
  ipcMain.on(CH.SHARE_SET_CONFIG, (_e, cfg: ShareHostConfig) => {
    if (!cfg || typeof cfg !== 'object') return
    host.applyConfig({ enabled: cfg.enabled === true, port: Number(cfg.port) })
  })
  ipcMain.handle(CH.SHARE_FIREWALL_CHECK, (_e, force: unknown): Promise<FirewallStatus> => firewall.check(force === true))
  ipcMain.handle(CH.SHARE_FIREWALL_FIX, (): Promise<FirewallFixRes> => firewall.fix())
}
