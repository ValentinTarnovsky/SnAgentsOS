/**
 * React side of the back stack (E1-FR-36). BackStackHost wraps the live
 * screen: it owns one BackStack bound to window.history, marks the live root
 * with replaceState({snagentsos:'root'}) (the URL is kept, so it stays
 * compatible with the client's replaceState that strips #pair=), listens to
 * popstate, and on unmount (leaving phase 'live') orphans every open claim.
 *
 * useBackClaim(open, onClose) is what a Sheet or PushScreen calls: while
 * `open` it holds a claim, the browser's back runs onClose, and the returned
 * requestClose() is what the component's own close affordances call (it pops
 * the entry and then runs onClose). A parent that just flips `open` to false
 * also releases the entry. Outside a host (isolated tests, other phases) it
 * degrades to plain onClose.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createBackStack, type BackStack } from './backStack'

const BackStackContext = createContext<BackStack | null>(null)

export function BackStackHost({ children }: { children: ReactNode }): ReactNode {
  const [stack] = useState<BackStack | null>(() => (typeof history !== 'undefined' ? createBackStack(history) : null))
  useEffect(() => {
    if (!stack) return
    try {
      history.replaceState({ snagentsos: 'root' }, '')
    } catch {
      /* ignore */
    }
    const onPop = (): void => stack.onPopState()
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      stack.orphanAll()
    }
  }, [stack])
  return createElement(BackStackContext.Provider, { value: stack }, children)
}

export function useBackClaim(open: boolean, onClose: () => void): { requestClose: () => void } {
  const stack = useContext(BackStackContext)
  const id = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open || !stack) return
    stack.push(id, () => onCloseRef.current())
    // Closed by the parent (or unmounted) while still claimed: drop the entry.
    return () => stack.requestClose(id)
  }, [open, stack, id])

  const requestClose = useCallback(() => {
    stack?.requestClose(id)
    onCloseRef.current()
  }, [stack, id])

  return { requestClose }
}
