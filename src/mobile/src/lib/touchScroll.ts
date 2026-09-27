import type { Terminal } from '@xterm/xterm'

/** xterm handles touch scrollback only when the application has not captured the mouse. */
export function attachTouchScroll(term: Terminal, container: HTMLElement): () => void {
  let gesture: { id: number; x: number; y: number; lastY: number; remainder: number; axis: 'pending' | 'vertical' | 'horizontal' } | null = null
  const reset = (): void => { gesture = null }
  const start = (event: TouchEvent): void => {
    reset()
    if (event.touches.length !== 1 || term.modes.mouseTrackingMode === 'none') return
    const touch = event.touches[0]
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, axis: 'pending' }
  }
  const move = (event: TouchEvent): void => {
    if (!gesture) return
    if (event.touches.length !== 1 || term.modes.mouseTrackingMode === 'none') { reset(); return }
    const touch = event.touches[0]
    if (touch.identifier !== gesture.id) { reset(); return }
    if (gesture.axis === 'pending') {
      const dx = Math.abs(touch.clientX - gesture.x), dy = Math.abs(touch.clientY - gesture.y)
      if (Math.max(dx, dy) < 8) return // Keep taps and small finger jitter as taps.
      gesture.axis = dy >= dx ? 'vertical' : 'horizontal'
    }
    if (gesture.axis !== 'vertical') return // Preserve the grid's horizontal pan.
    event.preventDefault()
    const screen = container.querySelector<HTMLElement>('.xterm-screen')
    const element = term.element
    if (!screen || !element) return
    const rect = screen.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const lineHeight = Math.max(8, rect.height / term.rows)
    gesture.remainder += gesture.lastY - touch.clientY
    gesture.lastY = touch.clientY
    const lines = Math.trunc(gesture.remainder / lineHeight)
    gesture.remainder -= lines * lineHeight
    // Let xterm encode the current mouse protocol and route through its normal
    // input listener. It emits one wheel report per event, regardless of delta size.
    for (let i = 0; i < Math.min(Math.abs(lines), 30); i++) {
      element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: Math.sign(lines),
        clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, touch.clientX)),
        clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, touch.clientY)),
      }))
    }
  }
  // Capture before xterm's handlers. Do not cancel touchstart: taps still focus
  // its textarea and open the keyboard. Multi-touch and cancelled drags reset.
  container.addEventListener('touchstart', start, { capture: true, passive: true })
  container.addEventListener('touchmove', move, { capture: true, passive: false })
  container.addEventListener('touchend', reset, true)
  container.addEventListener('touchcancel', reset, true)
  return () => {
    reset()
    container.removeEventListener('touchstart', start, true)
    container.removeEventListener('touchmove', move, true)
    container.removeEventListener('touchend', reset, true)
    container.removeEventListener('touchcancel', reset, true)
  }
}
