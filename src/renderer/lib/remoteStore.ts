import { create } from 'zustand'
import type {
  PairingQrPayload,
  PendingPairingInfo,
  RemoteServerStatus,
  RemoteUiState,
  SanitizedDevice,
} from '@shared/ipc-contract'
import type { RemoteSettings } from '@shared/types'

/** Neutral status shown until main reports the real server state. */
const STOPPED: RemoteServerStatus = {
  state: 'stopped',
  port: 4517,
  endpoints: [],
  connectedCount: 0,
}

interface RemoteState {
  /** Live server status (state, port, reachable endpoints, connected count). */
  status: RemoteServerStatus
  /** Paired devices (sanitized; never carry the shared secret). */
  devices: SanitizedDevice[]
  /** In-flight pairing request awaiting Allow/Deny, or null. */
  pendingPairing: PendingPairingInfo | null
  /** Active pairing code + one QR per endpoint, or null when no code is minted. */
  qr: PairingQrPayload | null
  /** Whether the QR modal is open. */
  qrOpen: boolean

  /** Open/close the QR modal (opening mints a fresh code, closing cancels it). */
  setQrOpen: (open: boolean) => void
  /** Approve the pending pairing request. */
  approve: () => void
  /** Deny the pending pairing request. */
  deny: () => void
  /** Forget a paired device and kill its live sessions. */
  revoke: (deviceId: string) => Promise<void>
  /** (Re)mint the pairing code + QRs while the modal is open. */
  refreshQr: () => Promise<void>
  /** Invalidate the active pairing code and close the modal. */
  cancelQr: () => void
}

export const useRemoteStore = create<RemoteState>((set, get) => ({
  status: STOPPED,
  devices: [],
  pendingPairing: null,
  qr: null,
  qrOpen: false,

  setQrOpen: (open) => {
    if (open) {
      set({ qrOpen: true })
      void get().refreshQr()
    } else {
      get().cancelQr()
    }
  },

  approve: () => {
    const pending = get().pendingPairing
    if (pending) window.snApi.remote.pairingResolve(pending.requestId, true)
  },

  deny: () => {
    const pending = get().pendingPairing
    if (pending) window.snApi.remote.pairingResolve(pending.requestId, false)
  },

  revoke: async (deviceId) => {
    await window.snApi.remote.revokeDevice(deviceId)
  },

  refreshQr: async () => {
    try {
      const qr = await window.snApi.remote.pairingBegin()
      set({ qr })
    } catch {
      set({ qr: null })
    }
  },

  cancelQr: () => {
    window.snApi.remote.pairingCancel()
    set({ qrOpen: false, qr: null })
  },
}))

function applyUiState(s: RemoteUiState): void {
  useRemoteStore.setState({
    status: s.status,
    devices: s.devices,
    pendingPairing: s.pendingPairing,
  })
}

let wired = false

/** Wire the main->renderer remote-state stream and pull the first snapshot (idempotent). */
export function initRemoteEvents(): () => void {
  if (wired) return () => undefined
  wired = true
  const off = window.snApi.remote.onEvent((s) => applyUiState(s))
  void window.snApi.remote
    .getState()
    .then((s) => applyUiState(s))
    .catch(() => undefined)
  return () => {
    wired = false
    off()
  }
}

/** Push the remote settings to main (it diffs and starts/stops/restarts the server). */
export function syncRemoteConfig(cfg: RemoteSettings): void {
  window.snApi.remote.setConfig(cfg)
}
