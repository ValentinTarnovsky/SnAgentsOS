/**
 * Saved scrollback of panes that go away (E6-FR-12): main moves their files
 * to its trash, which the next start empties, so a console reopened in this
 * session can still get its history back. Fire and forget; a renderer
 * without the API (tests, an old preload) skips it.
 */
export function trashSavedScrollback(paneIds: readonly string[]): void {
  const api = typeof window !== 'undefined' ? window.snApi?.scrollback : undefined
  if (!api) return
  for (const paneId of paneIds) void Promise.resolve().then(() => api.clear(paneId, { trash: true })).catch(() => undefined)
}

/** "Clear saved history" of one pane: deleted at once, the screen stays as it is. */
export function clearSavedScrollback(paneId: string): void {
  const api = typeof window !== 'undefined' ? window.snApi?.scrollback : undefined
  if (api) void Promise.resolve().then(() => api.clear(paneId)).catch(() => undefined)
}
