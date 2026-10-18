/**
 * Back-button stack for the phone's sheets and pushed screens (E1-FR-36).
 * Pure (no DOM): the History slice is injected, so test-mobile-logic.cjs drives
 * it with a fake history.
 *
 * Every open sheet or screen is a claim that owns one history entry
 * (pushState({snagentsos:id})). The browser's back (Android back, Safari
 * edge-swipe) fires popstate, which closes only the newest claim. Closing from
 * the UI (handle, backdrop, an action) calls history.back() to drop the entry
 * and marks the claim "closing", so the popstate that follows is consumed
 * without closing anything else: no double pop, and the next back does not
 * leave the app.
 *
 * While such a back() is in flight, new pushState calls are deferred until its
 * popstate lands: browsers differ on whether a pushState issued before the
 * traversal runs cancels it, and serializing keeps the entry count exact.
 *
 * orphanAll() is for the host unmounting with claims open (a phase change, for
 * example to 'updated'): every claim is dropped and history.go(-n) removes
 * their entries in one traversal, so a single back then leaves the app.
 */

export type BackHistory = Pick<History, 'pushState' | 'back' | 'go'>

export interface BackStack {
  push(id: string, onClose: () => void): void
  /** Marks the claim closing and calls history.back(). */
  requestClose(id: string): void
  /** Closes the newest non-closing claim, or consumes a closing one without calling onClose. */
  onPopState(): void
  /** Drops every claim; returns n, the entries removed with history.go(-n). */
  orphanAll(): number
  /** Claims still tracked (closing ones included until their popstate). */
  size(): number
  has(id: string): boolean
}

interface Claim {
  id: string
  onClose: () => void
  /** history.back() was called for it; waiting for its popstate. */
  closing: boolean
  /** Its history entry exists (pushState ran). */
  pushed: boolean
}

export function createBackStack(h: BackHistory): BackStack {
  let claims: Claim[] = []
  /** back() calls whose popstate has not arrived yet. */
  let pendingPops = 0

  const flush = (): void => {
    if (pendingPops > 0) return
    for (const c of claims) {
      if (c.pushed || c.closing) continue
      c.pushed = true
      try {
        h.pushState({ snagentsos: c.id }, '')
      } catch {
        /* a sandboxed frame can refuse; the claim still closes from the UI */
      }
    }
  }

  const lastIndex = (pred: (c: Claim) => boolean): number => {
    for (let i = claims.length - 1; i >= 0; i--) if (pred(claims[i])) return i
    return -1
  }

  return {
    push(id, onClose) {
      if (claims.some((c) => c.id === id && !c.closing)) return
      claims.push({ id, onClose, closing: false, pushed: false })
      flush()
    },
    requestClose(id) {
      const i = lastIndex((c) => c.id === id && !c.closing)
      if (i < 0) return
      const c = claims[i]
      if (!c.pushed) {
        // Deferred and never reached history: nothing to pop.
        claims.splice(i, 1)
        return
      }
      c.closing = true
      pendingPops++
      h.back()
    },
    onPopState() {
      if (pendingPops > 0) {
        pendingPops--
        const i = lastIndex((c) => c.closing)
        if (i >= 0) claims.splice(i, 1)
        flush()
        return
      }
      const i = lastIndex((c) => c.pushed && !c.closing)
      if (i < 0) return
      const [c] = claims.splice(i, 1)
      c.onClose()
    },
    orphanAll() {
      const n = claims.filter((c) => c.pushed && !c.closing).length
      claims = []
      pendingPops = 0
      if (n > 0) h.go(-n)
      return n
    },
    size() {
      return claims.length
    },
    has(id) {
      return claims.some((c) => c.id === id)
    },
  }
}
