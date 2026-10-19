/**
 * Copy from the phone (E2-FR-27). The page is usually plain http on the LAN,
 * where navigator.clipboard does not exist, so the fallback is the old
 * execCommand('copy') on an off-screen textarea. It only works inside the
 * user's gesture: copyText is synchronous and must be called straight from the
 * tap's handler, never after an await.
 *
 * The textarea is readonly with a 16px font (iOS neither raises the keyboard
 * nor zooms the viewport), the range is set with setSelectionRange (iOS ignores
 * select() on a readonly field) and it is blurred and removed right after.
 */

/** Where the async Clipboard API is usable (https or localhost). */
function canUseClipboardApi(): boolean {
  try {
    return typeof window !== 'undefined' && window.isSecureContext && typeof navigator.clipboard?.writeText === 'function'
  } catch {
    return false
  }
}

/** execCommand on a hidden readonly textarea. True when the browser says it copied. */
export function execCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.readOnly = true
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.setAttribute('data-copy-buffer', '')
  ta.tabIndex = -1
  Object.assign(ta.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    width: '1px',
    height: '1px',
    opacity: '0',
    fontSize: '16px',
    border: '0',
    padding: '0',
  })
  document.body.appendChild(ta)
  let ok = false
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    ta.blur()
    ta.remove()
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* nothing selected */
    }
  }
  return ok
}

/**
 * Put `text` on the clipboard. Returns false when the copy surely failed, so
 * the caller can show the long-press fallback sheet. With the Clipboard API the
 * write is async: a later rejection calls `onLateFail` (the gesture is over by
 * then, so execCommand cannot be retried).
 */
export function copyText(text: string, onLateFail?: () => void): boolean {
  if (!text) return false
  if (canUseClipboardApi()) {
    try {
      void navigator.clipboard.writeText(text).catch(() => {
        if (!execCopy(text)) onLateFail?.()
      })
      return true
    } catch {
      /* fall through to execCommand */
    }
  }
  return execCopy(text)
}
