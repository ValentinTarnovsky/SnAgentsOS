/**
 * The FAB's console picker (E2-FR-10/11): workspace chips (default: the
 * workspace of the last viewed console, else the desktop's active one, else
 * the first), the desktop presets in their order (default: the first claude
 * preset), an optional initial prompt for claude/codex presets and "Open
 * console". It sends `ctl createPane {workspaceId, presetId, prompt?}` and
 * opens the acked console; the desktop starts only that console and keeps its
 * own workspace on screen.
 *
 * The prompt travels as the agent's positional argument (main's
 * SNAOS_INITIAL_PROMPT, E2-FR-11). When that is not possible the ack says
 * `promptFallback`: the text goes to that console's composer draft (Composer
 * mode) with the toast "The prompt stayed in the composer". Past
 * ARGV_PROMPT_MAX characters the hint already warns about it.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import type { PaneType } from '@shared/types'
import type { RemoteStateSnapshot } from '@shared/remote-protocol'
import { Sheet } from '../Sheet'
import { PrimaryButton } from '../InfoScreen'
import { store, useRemoteStore } from '../../lib/store'
import { client } from '../../lib/client'
import { saveDraft } from '../../lib/drafts'
import { PaneIcon } from '../../lib/paneIcon'
import { workspaceOfPane } from '../../lib/workspace'
import { t } from '../../lib/i18n'
import { MicButton, VoiceInterim } from '../MicButton'
import { spaced, stopDictation } from '../../lib/voice'

/** Longest prompt the ctl accepts (createPane.prompt, the contract bound). */
export const PROMPT_MAX = 16384
/** Past this the prompt cannot go on the command line (ARGV_PROMPT_MAX in main). */
export const PROMPT_ARGV_HINT = 2000

interface PresetOption {
  id: string
  name: string
  type: PaneType
  color: string
}

/** The picker's default workspace (E2-FR-10). */
export function defaultWorkspaceId(snap: RemoteStateSnapshot, lastPane: string | null): string | null {
  const viewed = lastPane ? workspaceOfPane(snap, lastPane) : null
  if (viewed) return viewed
  if (snap.activeWorkspaceId && snap.workspaces.some((w) => w.id === snap.activeWorkspaceId)) return snap.activeWorkspaceId
  return snap.workspaces[0]?.id ?? null
}

/** Presets in desktop order; an older desktop without them gets a plain shell. */
function presetOptions(snap: RemoteStateSnapshot | null): PresetOption[] {
  const list = snap?.presets ?? []
  if (list.length > 0) return list.map((p) => ({ id: p.id, name: p.name, type: p.type, color: p.color }))
  return [{ id: '', name: t('newConsole.shell'), type: 'shell', color: '' }]
}

const isAgent = (type: PaneType | undefined): boolean => type === 'claude' || type === 'codex'

export function NewConsoleSheet({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean
  onClose: () => void
  /** Workspace to start on (a section's "New console here"); null = the default. */
  workspaceId: string | null
}): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const [wsId, setWsId] = useState<string | null>(null)
  const [presetId, setPresetId] = useState<string>('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const options = presetOptions(snapshot)

  // Every opening starts from the defaults.
  useEffect(() => {
    if (!open) return
    const snap = store.getState().snapshot
    if (!snap) return
    const valid = workspaceId && snap.workspaces.some((w) => w.id === workspaceId) ? workspaceId : null
    setWsId(valid ?? defaultWorkspaceId(snap, store.getState().lastPane))
    const opts = presetOptions(snap)
    setPresetId((opts.find((p) => p.type === 'claude') ?? opts[0]).id)
    setText('')
    setBusy(false)
  }, [open, workspaceId])

  const preset = options.find((p) => p.id === presetId) ?? options[0]
  const showPrompt = isAgent(preset?.type)

  const submit = async (): Promise<void> => {
    if (!wsId || busy) return
    setBusy(true)
    stopDictation('newConsole', true)
    const prompt = showPrompt && text.trim() ? text : undefined
    const res = await client.sendCtl({
      kind: 'createPane',
      workspaceId: wsId,
      ...(preset?.id ? { presetId: preset.id } : { paneType: 'shell' as const }),
      ...(prompt ? { prompt } : {}),
    })
    setBusy(false)
    if (!res.ok || !res.paneId) {
      store.getState().setToast(t('toast.createFailed'))
      return
    }
    if (prompt && res.promptFallback) {
      // E2-FR-11: the console opened without it; it waits in its composer.
      saveDraft(res.paneId, prompt)
      store.getState().setInputMode(res.paneId, 'composer')
      store.getState().setToast(t('toast.promptToComposer'))
    }
    onClose()
    client.showPane(res.paneId)
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('newConsole.title')}>
      <div data-new-console className="flex flex-col gap-4">
        <section>
          <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('newConsole.workspace')}</h3>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" style={{ scrollbarWidth: 'none', touchAction: 'pan-x' }} data-scrollable>
            {(snapshot?.workspaces ?? []).map((ws) => (
              <button
                key={ws.id}
                data-ws-chip={ws.id}
                aria-pressed={ws.id === wsId}
                onClick={() => setWsId(ws.id)}
                className={clsx(
                  'h-9 max-w-[60vw] shrink-0 truncate rounded-full border px-3 text-xs font-medium',
                  ws.id === wsId ? 'border-accent-violet bg-accent-violet text-white' : 'border-border bg-bg-secondary text-text-primary active:bg-card',
                )}
              >
                {ws.name}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('newConsole.preset')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {options.map((p) => (
              <button
                key={p.id || 'shell'}
                data-preset={p.id || 'shell'}
                data-preset-type={p.type}
                aria-pressed={p.id === preset?.id}
                onClick={() => setPresetId(p.id)}
                className={clsx(
                  'flex min-h-12 min-w-0 items-center gap-2 rounded-btn border px-3 py-2 text-left text-sm',
                  p.id === preset?.id ? 'border-accent-violet bg-accent-violet/10 text-text-primary' : 'border-border bg-bg-secondary text-text-primary active:bg-card',
                )}
              >
                <span style={p.color ? { color: p.color } : undefined}>
                  <PaneIcon type={p.type} size={16} />
                </span>
                <span className="min-w-0 truncate">{p.name}</span>
              </button>
            ))}
          </div>
        </section>
        {showPrompt && (
          <section>
            <label className="mb-1.5 block px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary" htmlFor="new-console-prompt">
              {t('newConsole.prompt')}
            </label>
            <VoiceInterim owner="newConsole" />
            <div className="flex items-start gap-2">
              <textarea
                id="new-console-prompt"
                data-new-prompt
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={PROMPT_MAX}
                rows={Math.min(6, Math.max(1, text.split('\n').length))}
                className="min-w-0 flex-1 resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-base text-text-primary outline-none focus:border-accent-violet"
              />
              {/* v2.2: dictation fills the prompt; the console opens only from the button below. */}
              {open && <MicButton owner="newConsole" resetKey={preset?.id} onFinal={(chunk) => setText((prev) => (prev + spaced(prev, chunk)).slice(0, PROMPT_MAX))} />}
            </div>
            {text.length > PROMPT_ARGV_HINT && (
              <p data-prompt-hint className="mt-1 px-1 text-[11px] text-text-secondary">
                {t('newConsole.toComposer')}
              </p>
            )}
          </section>
        )}
        <PrimaryButton onClick={() => void submit()} disabled={!wsId || busy}>
          <span className="inline-flex items-center gap-2">
            {busy && <Loader2 size={16} className="spin" />}
            {t('newConsole.open')}
          </span>
        </PrimaryButton>
      </div>
    </Sheet>
  )
}
