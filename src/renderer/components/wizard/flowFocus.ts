/**
 * Where focus returns when the new-workspace flow is cancelled (E4-FR-31).
 * The composer records it on open; "Advanced..." hands it on to the 3-step
 * wizard, whose own capture would only find the unmounted composer.
 */
let returnTo: HTMLElement | null = null

export function rememberFlowFocus(el: HTMLElement | null): void {
  returnTo = el
}

/** The recorded element (once), or null. */
export function takeFlowFocus(): HTMLElement | null {
  const el = returnTo
  returnTo = null
  return el
}
