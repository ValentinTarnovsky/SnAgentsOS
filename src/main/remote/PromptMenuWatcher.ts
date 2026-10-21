/**
 * app 2.4.0: Claude's answer menu for the phone's Chat view. The Chat view
 * pauses the pane's terminal stream, so the phone cannot read the menu off
 * its own xterm there; main reads it off the pty's headless mirror instead
 * and sends it inside RemotePaneStatus.menu, where the Plan card and "Always
 * allow" take their options from.
 *
 *  - A pane is a target only while its status is a precise Claude track in
 *    `action` with a pending plan or permission (pending[] already leaves out
 *    the requests that input invalidated, E2-FR-48). The plan wins over a
 *    permission, like the phone's cardFor.
 *  - It is read only while some authenticated phone watches the pane (`sub`
 *    or `chatSub`): when the request arrives, when a phone starts watching,
 *    and on pty output, at most once per MENU_READ_THROTTLE_MS. Every read
 *    runs on a timer, never inside a pty callback.
 *  - The menu counts only once it validates for the request's kind
 *    (planOptions for a plan, alwaysOption for a permission); anything else
 *    is no menu, and the phone keeps its fallbacks.
 *  - A change of the menu calls onChange, which re-broadcasts the pane's full
 *    status (RemoteManager.pushPaneStatus), so the 100 ms coalesce and the
 *    dedupe apply and a later identical menu is not sent again.
 *
 * Pure of Electron: the screen, the watch check and the timers are injected.
 */
import { alwaysOption, parseMenu, planOptions, type MenuOption } from '@shared/promptMenu'
import type { RemotePaneMenu, RemotePending } from '@shared/remote-protocol'
import type { PaneStatusEvt } from '@shared/types'
import type { PtySink } from '../pty/PtyManager'

/** Rows are re-read at most this often per pane while output streams in. */
export const MENU_READ_THROTTLE_MS = 250
/** Options one menu carries at most (digits 1..9). */
export const REMOTE_MENU_MAX_OPTIONS = 9
/** Longest option label sent (MENU_LABEL_MAX of the shared parser). */
export const REMOTE_MENU_LABEL_MAX = 160

/** The request a pane's menu would answer. */
export interface MenuTarget {
  pendingId: string
  kind: 'plan' | 'permission'
}

type Timer = ReturnType<typeof setTimeout>

export interface PromptMenuWatcherDeps {
  /** The pane's pty screen rows, null when they cannot be read (PtyManager.screenRows). */
  screenRows(paneId: string): string[] | null
  /** Some authenticated phone has the pane in `subs` or `chatSubs`. */
  isWatched(paneId: string): boolean
  /** The pane's menu changed (set, replaced or cleared): re-broadcast its status. */
  onChange(paneId: string): void
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => Timer
  clearTimeout?: (timer: Timer) => void
}

/** The request of a status event whose menu main reads, or null. */
export function menuTarget(evt: Pick<PaneStatusEvt, 'state' | 'precise' | 'provider' | 'pending'> | null | undefined): MenuTarget | null {
  if (!evt || evt.state !== 'action' || evt.precise !== true || (evt.provider ?? 'claude') !== 'claude') return null
  const pending = evt.pending ?? []
  const plan = pending.find((p) => p.kind === 'plan')
  if (plan) return { pendingId: plan.id, kind: 'plan' }
  const permission = pending.find((p) => p.kind === 'permission')
  return permission ? { pendingId: permission.id, kind: 'permission' } : null
}

/** The menu on these rows when it validates for `kind`, bounded for the wire; else null. */
export function validMenu(rows: readonly string[] | null, kind: MenuTarget['kind']): MenuOption[] | null {
  if (!rows) return null
  const menu = parseMenu(rows)
  if (!menu || menu.length > REMOTE_MENU_MAX_OPTIONS) return null
  const ok = kind === 'plan' ? planOptions(menu) !== null : alwaysOption(menu) !== null
  if (!ok) return null
  return menu.map((o) => ({ n: o.n, label: o.label.slice(0, REMOTE_MENU_LABEL_MAX) }))
}

const menuKey = (menu: RemotePaneMenu | undefined): string => (menu ? `${menu.for}\n${menu.options.map((o) => `${o.n}:${o.label}`).join('\n')}` : '')

export class PromptMenuWatcher implements PtySink {
  readonly id = 'remote-prompt-menu'
  private readonly targets = new Map<string, MenuTarget>()
  private readonly menus = new Map<string, RemotePaneMenu>()
  private readonly timers = new Map<string, Timer>()
  private readonly lastRead = new Map<string, number>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => Timer
  private readonly clearTimer: (timer: Timer) => void

  constructor(private readonly deps: PromptMenuWatcherDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimeout ?? ((timer) => clearTimeout(timer))
  }

  /** A status event of the pane (every StatusManager emit, before the phones get it). */
  onStatus(evt: PaneStatusEvt): void {
    const paneId = evt.paneId
    const target = menuTarget(evt)
    const prev = this.targets.get(paneId)
    if (!target) {
      if (prev) this.forget(paneId)
      return
    }
    if (prev && prev.pendingId === target.pendingId && prev.kind === target.kind) return
    this.targets.set(paneId, target)
    // A menu read for another request never answers this one.
    this.menus.delete(paneId)
    this.lastRead.delete(paneId)
    this.schedule(paneId)
  }

  /**
   * The menu to send with this pane's status: only while its request is
   * still in `pending` (a status built between two reads never carries a
   * menu for a request that is gone).
   */
  menuFor(paneId: string, pending?: readonly RemotePending[]): RemotePaneMenu | undefined {
    const menu = this.menus.get(paneId)
    if (!menu || !pending?.some((p) => p.id === menu.for)) return undefined
    return menu
  }

  /** The request main reads the menu for, or null (answerMenu checks against the status itself). */
  targetOf(paneId: string): MenuTarget | null {
    return this.targets.get(paneId) ?? null
  }

  /** A phone started watching the pane (`sub` or `chatSub`): read it now. */
  watch(paneId: string): void {
    if (this.targets.has(paneId)) this.schedule(paneId)
  }

  /** Every pane read again (a phone connected, or the server came up). */
  refreshAll(): void {
    for (const paneId of this.targets.keys()) this.schedule(paneId)
  }

  /** Server gone: drop the menus and timers, keep the requests (they live in StatusManager). */
  reset(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer)
    this.timers.clear()
    this.menus.clear()
    this.lastRead.clear()
  }

  dispose(): void {
    this.reset()
    this.targets.clear()
  }

  // --- PtySink ---------------------------------------------------------------

  onSpawn(_ptyId: string, paneId: string): void {
    // A new pty backs the pane: the old screen's menu answers nothing.
    if (this.menus.has(paneId)) this.clearMenu(paneId)
  }

  onData(_ptyId: string, paneId: string): void {
    if (this.targets.has(paneId)) this.schedule(paneId)
  }

  onExit(_ptyId: string, paneId: string): void {
    if (this.menus.has(paneId)) this.clearMenu(paneId)
  }

  // --- internals ---------------------------------------------------------------

  private forget(paneId: string): void {
    this.targets.delete(paneId)
    this.lastRead.delete(paneId)
    const timer = this.timers.get(paneId)
    if (timer !== undefined) this.clearTimer(timer)
    this.timers.delete(paneId)
    // The status that dropped the request is already going out without a menu.
    this.menus.delete(paneId)
  }

  private clearMenu(paneId: string): void {
    this.menus.delete(paneId)
    this.deps.onChange(paneId)
  }

  private schedule(paneId: string): void {
    if (this.timers.has(paneId)) return
    const last = this.lastRead.get(paneId)
    const wait = last === undefined ? 0 : Math.max(0, last + MENU_READ_THROTTLE_MS - this.now())
    const timer = this.setTimer(() => {
      this.timers.delete(paneId)
      this.read(paneId)
    }, wait)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.set(paneId, timer)
  }

  private read(paneId: string): void {
    const target = this.targets.get(paneId)
    if (!target) return
    const before = this.menus.get(paneId)
    let next: RemotePaneMenu | undefined
    if (this.deps.isWatched(paneId)) {
      this.lastRead.set(paneId, this.now())
      let rows: string[] | null = null
      try {
        rows = this.deps.screenRows(paneId)
      } catch {
        rows = null
      }
      const options = validMenu(rows, target.kind)
      if (options) next = { for: target.pendingId, options }
    }
    if (menuKey(before) === menuKey(next)) return
    if (next) this.menus.set(paneId, next)
    else this.menus.delete(paneId)
    this.deps.onChange(paneId)
  }
}
