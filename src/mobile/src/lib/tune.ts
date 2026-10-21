/**
 * Phone side of the model / effort / Ultracode sheet (app 2.3.0, ctl
 * `agentTune`). The "Apply with Enter" switch is a per-phone preference
 * ('snagentsos.tune.enter', '1' when on; absent = off, the default), so the
 * desktop config is untouched. The sheet and its header chip only show to a
 * desktop >= 2.3.0: an older one rejects the unknown ctl kind as a malformed
 * frame (a strike), never with an ack.
 */
import type { AgentProvider, PaneType } from '@shared/types'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { appVersionAtLeast } from '@shared/agentTune'
import { STORAGE_PREFIX, storageGet, storageRemove, storageSet } from './mobileStorage'

export const TUNE_ENTER_KEY = `${STORAGE_PREFIX}tune.enter`

export function loadTuneEnter(): boolean {
  return storageGet(TUNE_ENTER_KEY) === '1'
}

export function saveTuneEnter(on: boolean): void {
  if (on) storageSet(TUNE_ENTER_KEY, '1')
  else storageRemove(TUNE_ENTER_KEY)
}

/** The desktop knows `agentTune` (authOk.appVersion >= 2.3.0, 'dev' included). */
export function tuneSupported(appVersion: string | undefined): boolean {
  return appVersionAtLeast(appVersion)
}

/** The agent a console runs for the sheet: the live status first, then the pane type; null for anything else. */
export function tuneProvider(type: PaneType | undefined, status: RemotePaneStatus | null | undefined): AgentProvider | null {
  if (status?.provider) return status.provider
  return type === 'claude' || type === 'codex' ? type : null
}

/** The header chip's text ("opus · high · UC"), or null when nothing is known yet. */
export function tuneChipText(status: RemotePaneStatus | null | undefined): string | null {
  const parts = [status?.model, status?.effort, status?.ultracode ? 'UC' : undefined].filter((p): p is string => !!p)
  return parts.length ? parts.join(' · ') : null
}
