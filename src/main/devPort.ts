/**
 * Plan A1.3: the dev instance of a linked git worktree moves every listener
 * still on its default port (remote 4517, share 4527, hooks 43917) by a fixed
 * offset, so it runs next to the installed app and the main dev instance. A
 * port the user picked stays as configured. The offset follows the checkout
 * (devPortOffset() in devUserData.ts: 0 when packaged and for the main
 * checkout), so it also holds under --user-data-dir.
 *
 * Applied inside the services (RemoteManager.applyConfig, ShareHost.applyConfig
 * and ensureServer in registerStatusIpc), not at boot only: the renderer pushes
 * the unshifted port again on every settings change. Pure (no electron, no
 * fs): those modules import it and the suites load them with partial stubs.
 * devUserData.ts sets the offset at import time (first import of index.ts);
 * anywhere else it stays 0.
 */

/**
 * Range of a worktree's offset (89 values from its sha8). Never 10, so a
 * worktree's remote port (4517 + 10) is never the default share port, and
 * never 1, so its hook port is never 43918, the hook server's fallback.
 */
export const DEV_PORT_OFFSET_MIN = 11
export const DEV_PORT_OFFSET_MAX = 99

let offset = 0

/** Anything outside DEV_PORT_OFFSET_MIN..MAX (0 included) means no offset. */
export function setDevPortOffset(n: number): void {
  offset = Number.isInteger(n) && n >= DEV_PORT_OFFSET_MIN && n <= DEV_PORT_OFFSET_MAX ? n : 0
}

/** The port a listener binds: its default one moved by the offset, any other one as configured. */
export function devPort(port: number, defaultPort: number): number {
  return port === defaultPort ? port + offset : port
}
