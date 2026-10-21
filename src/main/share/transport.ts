/**
 * What carries a share connection (app 2.4.0, item 8). The host session and
 * the guest link only see this interface, so the direct WebSocket of 2.4
 * (`WsTransport`, host socket and guest client) and a relay later slot in
 * without touching the protocol: SecureChannel (crypto.ts) already encrypts
 * end to end on top of it.
 *
 * Text frames carry the cleartext handshake, binary frames the sealed
 * records. `createMemoryTransportPair` joins two ends in process for tests.
 */
export type ShareFrame = string | Buffer

export interface ShareTransport {
  /** Peer address as the socket sees it (normalized IPv4), '' when not applicable. */
  readonly remoteIp: string
  send(frame: ShareFrame): void
  close(code: number, reason?: string): void
  /** Bytes queued but not yet sent (backpressure, mirror of ws.bufferedAmount). */
  bufferedAmount(): number
  onMessage(cb: (frame: ShareFrame) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  readonly closed: boolean
}

class MemoryEnd implements ShareTransport {
  peer: MemoryEnd | null = null
  private readonly messageCbs: Array<(frame: ShareFrame) => void> = []
  private readonly closeCbs: Array<(code: number, reason: string) => void> = []
  private isClosed = false
  /** Frames sent while the peer had no listener yet are delivered on its first onMessage. */
  private inbox: ShareFrame[] = []

  constructor(readonly remoteIp: string) {}

  get closed(): boolean {
    return this.isClosed
  }

  send(frame: ShareFrame): void {
    if (this.isClosed || !this.peer || this.peer.isClosed) return
    this.peer.deliver(typeof frame === 'string' ? frame : Buffer.from(frame))
  }

  deliver(frame: ShareFrame): void {
    if (this.messageCbs.length === 0) {
      this.inbox.push(frame)
      return
    }
    for (const cb of this.messageCbs) cb(frame)
  }

  close(code: number, reason = ''): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const cb of this.closeCbs) cb(code, reason)
    const peer = this.peer
    if (peer && !peer.isClosed) {
      peer.isClosed = true
      for (const cb of peer.closeCbs) cb(code, reason)
    }
  }

  bufferedAmount(): number {
    return 0
  }

  onMessage(cb: (frame: ShareFrame) => void): void {
    this.messageCbs.push(cb)
    const queued = this.inbox
    this.inbox = []
    for (const frame of queued) cb(frame)
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCbs.push(cb)
  }
}

/** Two joined in-process ends (synchronous delivery); a close on either reaches both. */
export function createMemoryTransportPair(guestIp = '127.0.0.1', hostIp = '127.0.0.1'): { guest: ShareTransport; host: ShareTransport } {
  const host = new MemoryEnd(guestIp)
  const guest = new MemoryEnd(hostIp)
  host.peer = guest
  guest.peer = host
  return { guest, host }
}
