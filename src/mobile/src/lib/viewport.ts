/**
 * Viewport discipline for a full-screen web terminal on a phone.
 *
 *  - Tracks visualViewport.height into the --vvh CSS var so the app shell
 *    shrinks when the soft keyboard opens and the KeyBar docks right above it.
 *  - Kills iOS overscroll / pull-to-refresh: the document never scrolls; only
 *    the xterm viewport and explicitly-scrollable sheets may move under touch.
 *  - MITIGATION for the keyboard-open lag: iOS fires visualViewport.resize
 *    late (partway through, or only after, the keyboard's slide animation),
 *    so typing right after a tap can happen against a layout that has not
 *    caught up yet. focusin/focusout start a short rAF loop that re-samples
 *    --vvh every frame instead of waiting on that one late event. This does
 *    NOT know the keyboard's final height any sooner - iOS still controls
 *    that timing - it just narrows the "typing blind" window.
 *  - keyboardInset (E1-FR-20): how much of the layout viewport the soft
 *    keyboard covers, innerHeight - (vv.height + vv.offsetTop), sampled by the
 *    same listeners. Together with which input field holds the focus it feeds
 *    the store's kbOpen, so a keyboard the OS hid without a blur (iOS "done",
 *    Android Back) still reads as closed.
 *
 * initViewport() is idempotent-ish (safe to call once at startup) and returns a
 * teardown, though in practice the client lives for the whole page lifetime.
 */

import { store } from './store'

type Cleanup = () => void

let inset = 0
const insetListeners = new Set<(px: number) => void>()

/** Current soft keyboard overlap in px (0 when closed or unmeasurable). */
export function keyboardInset(): number {
  return inset
}

/** Subscribe to keyboardInset changes. Returns an unsubscribe fn. */
export function onKeyboardInset(listener: (px: number) => void): Cleanup {
  insetListeners.add(listener)
  return () => {
    insetListeners.delete(listener)
  }
}

/** Pure: the keyboard overlap for the given viewport metrics. */
export function measureKeyboardInset(
  innerHeight: number,
  vv: { height: number; offsetTop: number } | null | undefined,
): number {
  if (!vv) return 0
  return Math.max(0, Math.round(innerHeight - (vv.height + vv.offsetTop)))
}

/**
 * Which keyboard-owning field an element is: the xterm helper textarea is
 * 'direct'; any other field opts in with a data-kb-input attribute (the
 * composer uses data-kb-input="composer"). Null for everything else.
 */
export function kbFieldOf(el: EventTarget | null): string | null {
  if (!(el instanceof HTMLElement)) return null
  if (el.classList.contains('xterm-helper-textarea')) return 'direct'
  return el.dataset.kbInput ?? null
}

function applyHeight(): void {
  const vv = window.visualViewport
  const h = vv ? vv.height : window.innerHeight
  document.documentElement.style.setProperty('--vvh', `${Math.round(h)}px`)
  const next = measureKeyboardInset(window.innerHeight, vv)
  if (next !== inset) {
    inset = next
    store.getState().setKeyboard({ inset })
    for (const listener of insetListeners) listener(inset)
  }
}

const FOCUS_SETTLE_MS = 450
const BLUR_SETTLE_MS = 250

/** One rAF handle at a time: focusin/focusout restart it, they never stack. */
let settleRaf: number | null = null

function startSettleLoop(durationMs: number): void {
  if (settleRaf != null) cancelAnimationFrame(settleRaf)
  const deadline = performance.now() + durationMs
  const tick = (now: number): void => {
    applyHeight()
    settleRaf = now < deadline ? requestAnimationFrame(tick) : null
  }
  settleRaf = requestAnimationFrame(tick)
}

/** True when the touch target is inside an area allowed to scroll. */
function inScrollable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest('.xterm-viewport, [data-scrollable]')
}

/** Wire up the viewport tracking + overscroll guards. Returns a teardown fn. */
export function initViewport(): Cleanup {
  applyHeight()

  const vv = window.visualViewport
  const onResize = (): void => applyHeight()
  vv?.addEventListener('resize', onResize)
  vv?.addEventListener('scroll', onResize)
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)

  // Start resampling --vvh immediately on focus, ahead of iOS's late resize.
  // focusin/focusout also track which input field owns the keyboard (kbOpen).
  const onFocusIn = (e: FocusEvent): void => {
    store.getState().setKeyboard({ focus: kbFieldOf(e.target) })
    startSettleLoop(FOCUS_SETTLE_MS)
  }
  const onFocusOut = (e: FocusEvent): void => {
    store.getState().setKeyboard({ focus: kbFieldOf(e.relatedTarget) })
    startSettleLoop(BLUR_SETTLE_MS)
  }
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)

  // Block page-level rubber-band: preventDefault any touchmove that is not
  // inside a scrollable region. Must be passive:false to be able to cancel.
  const onTouchMove = (e: TouchEvent): void => {
    if (!inScrollable(e.target)) e.preventDefault()
  }
  document.addEventListener('touchmove', onTouchMove, { passive: false })

  // Belt-and-suspenders: keep the document pinned at the origin if anything
  // (a focus scroll, an address-bar collapse) nudges it.
  const onScroll = (): void => {
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
  }
  window.addEventListener('scroll', onScroll, { passive: true })

  return () => {
    vv?.removeEventListener('resize', onResize)
    vv?.removeEventListener('scroll', onResize)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('orientationchange', onResize)
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', onFocusOut)
    if (settleRaf != null) cancelAnimationFrame(settleRaf)
    document.removeEventListener('touchmove', onTouchMove)
    window.removeEventListener('scroll', onScroll)
  }
}
