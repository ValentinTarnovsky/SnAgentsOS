import { app } from 'electron'
import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { BRAND } from '@shared/brand'
import { DEV_PORT_OFFSET_MAX, DEV_PORT_OFFSET_MIN, setDevPortOffset } from './devPort'

/** The git checkout a dev build runs from (plan A1.3). */
export interface DevCheckout {
  root: string
  /** `<root>/.git` is a file (`gitdir: ...`): a linked worktree, not the main checkout. */
  worktree: boolean
}

/**
 * Folders looked at from app.getAppPath() up: `electron .` gives the repo
 * root, `electron out/main/index.js` gives <repo>/out/main.
 */
const CHECKOUT_LEVELS = 3

function isAppPackage(file: string): boolean {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name === BRAND.packageName
  } catch {
    return false
  }
}

/**
 * The first folder from `appPath` up (CHECKOUT_LEVELS at most) with a .git
 * entry or the app's package.json; null when there is none (a copied out/
 * folder) or the folder cannot be read. A few statSync calls: it runs at
 * import time.
 */
export function findDevCheckout(appPath: string): DevCheckout | null {
  try {
    let dir = resolve(appPath)
    for (let i = 0; i < CHECKOUT_LEVELS; i++) {
      const git = statSync(join(dir, '.git'), { throwIfNoEntry: false })
      if (git) return { root: dir, worktree: git.isFile() }
      if (isAppPackage(join(dir, 'package.json'))) return { root: dir, worktree: false }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  } catch {
    /* unreadable folder: no checkout */
  }
  return null
}

/** sha8 of a checkout: sha256 of its root with forward slashes, no trailing slash, lowercase on win32. */
export function checkoutHash(root: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return createHash('sha256').update(platform === 'win32' ? slashed.toLowerCase() : slashed).digest('hex').slice(0, 8)
}

/** snagentsos-dev for the main checkout (or none found), snagentsos-dev-<sha8> for a linked worktree. */
export function devUserDataDirName(checkout: DevCheckout | null): string {
  return checkout?.worktree ? `${BRAND.devUserDataDir}-${checkoutHash(checkout.root)}` : BRAND.devUserDataDir
}

/** 0 for the main checkout; DEV_PORT_OFFSET_MIN + sha8 mod 89 for a linked worktree, the same on every run. */
export function devPortOffsetFor(checkout: DevCheckout | null): number {
  if (!checkout?.worktree) return 0
  return DEV_PORT_OFFSET_MIN + (parseInt(checkoutHash(checkout.root), 16) % (DEV_PORT_OFFSET_MAX - DEV_PORT_OFFSET_MIN + 1))
}

let checkout: DevCheckout | null | undefined

/** This dev process's checkout, looked up once. */
function currentCheckout(): DevCheckout | null {
  if (checkout === undefined) {
    try {
      checkout = findDevCheckout(app.getAppPath())
    } catch {
      checkout = null
    }
  }
  return checkout
}

/**
 * The port offset of this instance (devPort.ts): 0 when packaged and for the
 * main checkout. A linked worktree gets its offset also under --user-data-dir,
 * since it follows the checkout, not the profile.
 */
export function devPortOffset(): number {
  return app.isPackaged ? 0 : devPortOffsetFor(currentCheckout())
}

/**
 * E0-FR-26: a dev run gets its own userData unless --user-data-dir was
 * passed: <appData>/snagentsos-dev for the main checkout and (plan A1.3)
 * <appData>/snagentsos-dev-<sha8> for a linked git worktree, so the single
 * instance lock, which is per userData, lets both run side by side.
 * Otherwise dev would leave a config.json in %APPDATA%\snagentsos and the
 * first packaged start would skip the real migration. Must run before any
 * path is read (index.ts builds the stores at module load) and before
 * requestSingleInstanceLock, so it is the first import of index.ts and runs
 * at import time.
 */
export function isolateDevUserData(): boolean {
  if (app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return false
  app.setPath('userData', join(app.getPath('appData'), devUserDataDirName(currentCheckout())))
  return true
}

isolateDevUserData()
setDevPortOffset(devPortOffset())
