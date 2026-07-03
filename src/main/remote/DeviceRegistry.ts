/**
 * Persistent store of paired phones. Lives in remote-devices.json next to
 * config.json but is OWNED BY MAIN: device secrets never enter the
 * renderer-persisted config blob, and keeping it a separate file avoids two
 * writers racing on config.json.
 *
 * Losing this file just means every phone has to re-pair, so there is no .bak
 * ladder here (unlike ConfigStore); a corrupt/missing file loads as empty.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { z } from 'zod'
import type { SanitizedDevice } from '@shared/ipc-contract'
import { getConfigPath } from '../paths'

export interface StoredDevice {
  id: string
  name: string
  /** 256-bit shared secret (hex). Never leaves main except the one paired frame. */
  secret: string
  createdAt: number
  lastSeen: number
}

const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  secret: z.string().min(1),
  createdAt: z.number(),
  lastSeen: z.number(),
})

const fileSchema = z.object({
  version: z.literal(1),
  devices: z.array(deviceSchema),
})

/** Persist a device's lastSeen at most this often (bookkeeping, not critical). */
const LAST_SEEN_PERSIST_MS = 5 * 60 * 1000

export class DeviceRegistry {
  private readonly path = join(dirname(getConfigPath()), 'remote-devices.json')
  private readonly tmpPath = `${this.path}.tmp`
  private readonly devices = new Map<string, StoredDevice>()
  /** Last time each device's lastSeen was written to disk (throttle). */
  private readonly lastPersistedSeen = new Map<string, number>()

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const parsed = fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      for (const d of parsed.devices) this.devices.set(d.id, d)
    } catch {
      // Corrupt or unreadable: start empty. Phones re-pair; no recovery ladder.
      this.devices.clear()
    }
  }

  /** Atomic write (temp file + rename), mirroring ConfigStore's durability trick. */
  persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const payload = { version: 1 as const, devices: [...this.devices.values()] }
      writeFileSync(this.tmpPath, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(this.tmpPath, this.path)
    } catch (error) {
      console.error('[remote] failed to persist device registry:', error)
    }
  }

  get(id: string): StoredDevice | undefined {
    return this.devices.get(id)
  }

  get count(): number {
    return this.devices.size
  }

  /** Create + persist a new device, minting its id and 256-bit secret. */
  add(name: string): StoredDevice {
    const now = Date.now()
    const device: StoredDevice = {
      id: randomUUID(),
      name,
      secret: randomBytes(32).toString('hex'),
      createdAt: now,
      lastSeen: now,
    }
    this.devices.set(device.id, device)
    this.persist()
    return device
  }

  /**
   * Drop a device from memory only. Revocation must remove it here FIRST, then
   * kill its live sockets, THEN call persist(), so a socket can never be
   * re-authed against a secret already gone from memory.
   */
  deleteInMemory(id: string): boolean {
    this.lastPersistedSeen.delete(id)
    return this.devices.delete(id)
  }

  /** Bump lastSeen; persists at most once per LAST_SEEN_PERSIST_MS per device. */
  touchLastSeen(id: string): void {
    const device = this.devices.get(id)
    if (!device) return
    const now = Date.now()
    device.lastSeen = now
    const last = this.lastPersistedSeen.get(id) ?? 0
    if (now - last < LAST_SEEN_PERSIST_MS) return
    this.lastPersistedSeen.set(id, now)
    this.persist()
  }

  /** Device list safe for the renderer: no secrets, live-connection flag folded in. */
  listSanitized(connectedIds: Set<string>): SanitizedDevice[] {
    return [...this.devices.values()]
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeen: d.lastSeen,
        connected: connectedIds.has(d.id),
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }
}
