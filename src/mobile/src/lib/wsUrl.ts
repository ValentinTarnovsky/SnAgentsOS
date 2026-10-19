/**
 * The desktop's socket URL for the page's own origin. Over the secure mode's
 * https origin (E3-FR-42, `tailscale serve`) it must be `wss:`: a `ws:` socket
 * from an https page is mixed content and the browser refuses it outright.
 */
export function wsUrlFor(protocol: string, host: string): string {
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`
}
