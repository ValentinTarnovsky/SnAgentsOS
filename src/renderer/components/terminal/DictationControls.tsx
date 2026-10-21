import { useEffect, useRef } from 'react'
import { Download, Mic, MicOff, Settings2, Square, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { dictationAction, type DictationError } from '@shared/dictation'
import { useAppStore } from '@/lib/store'
import {
  dismissDictation,
  insertHeld,
  releaseDictationScope,
  setDictationFieldToggler,
  startDictation,
  stopDictation,
  toggleDictationPane,
  useDictationStore,
} from '@/lib/dictation'
import { focusPane } from '@/lib/focus'
import { Tooltip } from '@/components/ui/Tooltip'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'

/** The mic shows on Windows only: the local Whisper engine is a Windows x64 build (main answers `unsupported` elsewhere). */
function dictationAvailable(): boolean {
  return typeof window !== 'undefined' && window.snApi?.platform === 'win32'
}

function useScope(scope: string) {
  return useDictationStore(
    useShallow((s) => {
      const mine = s.scope === scope
      return {
        on: mine && s.phase !== 'idle',
        phase: mine ? s.phase : 'idle',
        interim: mine ? s.interim : '',
        engine: mine ? s.engine : null,
        fallback: mine ? s.fallback : null,
        error: mine ? s.error : null,
        held: mine ? s.held : '',
        slow: mine ? s.slow : false,
      }
    }),
  )
}

const pillBtn =
  'flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-px text-[11px] leading-4 text-text-primary transition-colors hover:bg-bg-secondary'

const ERR_KEY: Record<DictationError, MessageKey> = {
  model_missing: 'dictation.err.model_missing',
  vcredist: 'dictation.err.vcredist',
  gpu_failed: 'dictation.err.gpu_failed',
  mic_denied: 'dictation.err.mic_denied',
  no_mic: 'dictation.err.no_mic',
  audio: 'dictation.err.audio',
  timeout: 'dictation.err.timeout',
  internal: 'dictation.err.internal',
  spawn: 'dictation.err.spawn',
  exit: 'dictation.err.exit',
  unsupported: 'dictation.err.unsupported',
}

/** The text of a dictation error code. */
function errorKey(code: DictationError): MessageKey {
  return ERR_KEY[code] ?? 'dictation.err.internal'
}

/** The line shown while the session runs on CPU because the GPU failed. */
function fallbackKey(code: DictationError | null): MessageKey | null {
  return code === 'gpu_failed' ? 'dictation.fallback.gpu_failed' : null
}

/**
 * The way out of an error (dictationAction): Windows' microphone privacy page,
 * the VC++ runtime download, or Settings > Terminal > Dictado at the packs row.
 */
function ErrorActionButton({ code }: { code: DictationError | null }) {
  const t = useT()
  const action = dictationAction(code)
  if (!action) return null
  const label: MessageKey =
    action === 'microphone'
      ? 'dictation.openMic'
      : action === 'vcredist'
        ? 'dictation.openVcredist'
        : code === 'model_missing'
          ? 'dictation.openModels'
          : 'dictation.openDictationSettings'
  return (
    <button
      type="button"
      data-dictation-action={action}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        if (action === 'models') useAppStore.getState().openSettings('terminal#dictationModels')
        else void window.snApi.dictation?.openSettings(action).catch(() => false)
      }}
      className={pillBtn}
    >
      {action === 'vcredist' || code === 'model_missing' ? <Download size={11} className="shrink-0" /> : <Settings2 size={11} className="shrink-0" />}
      {t(label)}
    </button>
  )
}

/** Header mic of a console (before the clock); hidden with settings.dictation.headerButton off. */
export function PaneMicButton({ paneId }: { paneId: string }) {
  const t = useT()
  const enabled = useAppStore((s) => s.settings.dictation?.headerButton !== false)
  const on = useDictationStore((s) => s.phase !== 'idle' && s.scope === `pane:${paneId}`)
  if (!enabled || !dictationAvailable()) return null
  const label = on ? t('dictation.stop') : t('dictation.start')
  return (
    <Tooltip label={label}>
      <button
        draggable={false}
        aria-label={label}
        aria-pressed={on}
        data-pane-mic={on ? 'on' : 'off'}
        // Keeps the terminal's focus: the words go where its cursor is.
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          toggleDictationPane(paneId)
          requestAnimationFrame(() => focusPane(paneId))
        }}
        className={cn(
          'relative rounded p-1 transition-colors hover:bg-bg-secondary',
          on ? 'text-red-400 hover:text-red-400' : 'text-text-secondary hover:text-text-primary',
        )}
      >
        <Mic size={13} />
        {on && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-red-400 motion-reduce:animate-none" />}
      </button>
    </Tooltip>
  )
}

/**
 * Listening overlay of a console (bottom of the terminal): what is being
 * heard, the device (GPU / CPU), Stop, the slow-model notice, the GPU
 * fallback notice, an error with its way out (microphone page, VC++ runtime,
 * the packs in Settings), and the text the menu guard held back with Insert.
 * Unmounting the terminal stops the session.
 */
export function DictationOverlay({ paneId, onDone }: { paneId: string; onDone?: () => void }) {
  const t = useT()
  const scope = `pane:${paneId}`
  const st = useScope(scope)
  useEffect(() => () => releaseDictationScope(scope), [scope])
  if (!st.on && !st.error && !st.held) return null
  const fallback = fallbackKey(st.fallback)
  const status: MessageKey = st.phase === 'starting' ? 'dictation.starting' : st.phase === 'stopping' ? 'dictation.stopping' : 'dictation.listening'
  return (
    <div
      role="status"
      data-dictation-overlay={paneId}
      data-dictation-phase={st.phase}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        if (st.on) stopDictation()
        else dismissDictation()
        onDone?.()
      }}
      className="absolute inset-x-3 bottom-3 z-10 mx-auto max-w-xl space-y-1.5 rounded-btn border border-border bg-card/95 px-3 py-2 text-xs text-text-primary shadow-lg backdrop-blur"
    >
      <div className="flex items-center gap-2">
        {st.on ? (
          <span className="relative flex shrink-0 text-red-400">
            <Mic size={14} />
            {st.phase === 'listening' && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-red-400 motion-reduce:animate-none" />}
          </span>
        ) : (
          <MicOff size={14} className="shrink-0 text-text-secondary" />
        )}
        <span data-dictation-interim className={cn('min-w-0 flex-1 truncate', st.interim ? 'text-text-primary' : 'text-text-secondary')}>
          {st.on ? st.interim || t(status) : st.error ? t(errorKey(st.error)) : t('dictation.held')}
        </span>
        {st.on && st.engine && (
          <span data-dictation-engine={st.engine} className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-text-secondary">
            {t(st.engine === 'gpu' ? 'dictation.engine.gpu' : 'dictation.engine.cpu')}
          </span>
        )}
        {st.on ? (
          <button
            type="button"
            data-dictation-stop
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              stopDictation()
              onDone?.()
            }}
            className={pillBtn}
          >
            <Square size={10} className="shrink-0" />
            {t('dictation.stop')}
          </button>
        ) : (
          <button
            type="button"
            data-dictation-dismiss
            aria-label={t('common.close')}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              dismissDictation()
              onDone?.()
            }}
            className="shrink-0 rounded p-0.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {st.on && st.slow && (
        <p data-dictation-slow className="text-text-secondary">
          {t('dictation.startingSlow')}
        </p>
      )}
      {st.on && fallback && (
        <p data-dictation-fallback={st.fallback ?? ''} className="text-text-secondary">
          {t(fallback)}
        </p>
      )}
      {st.on && st.error && (
        <div data-dictation-error={st.error} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-red-400">{t(errorKey(st.error))}</span>
          <ErrorActionButton code={st.error} />
        </div>
      )}
      {!st.on && st.error && dictationAction(st.error) && (
        <div data-dictation-error={st.error} className="flex justify-end">
          <ErrorActionButton code={st.error} />
        </div>
      )}
      {st.held && (
        <div data-dictation-held className="space-y-1.5">
          {st.on && <p className="text-text-secondary">{t('dictation.held')}</p>}
          <p className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-primary px-2 py-1 font-mono text-[11px]">{st.held}</p>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              data-dictation-discard
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                useDictationStore.setState({ held: '' })
                onDone?.()
              }}
              className={pillBtn}
            >
              {t('dictation.discard')}
            </button>
            <button
              type="button"
              data-dictation-insert
              onPointerDown={(e) => e.preventDefault()}
              onClick={insertHeld}
              className={cn(pillBtn, 'border-accent-violet/50 bg-accent-violet/10')}
            >
              {t('dictation.insert')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export interface FieldDictationProps {
  /** Stable id of the field. */
  owner: string
  insert: (text: string) => void
  before: () => string
}

/**
 * Mic of a text field (the global prompt): inserts at its caret. While it is
 * mounted the `dictate` shortcut toggles it; unmounting stops the session.
 */
export function FieldMicButton({ owner, insert, before }: FieldDictationProps) {
  const t = useT()
  const scope = `field:${owner}`
  const on = useDictationStore((s) => s.phase !== 'idle' && s.scope === scope)
  // The latest callbacks, without restarting a running session on every render.
  const cbs = useRef({ insert, before })
  cbs.current = { insert, before }
  useEffect(() => {
    const toggle = (): void => {
      const s = useDictationStore.getState()
      if (s.phase !== 'idle' && s.scope === scope) stopDictation()
      else
        void startDictation({
          kind: 'field',
          owner,
          insert: (text) => cbs.current.insert(text),
          before: () => cbs.current.before(),
        })
    }
    setDictationFieldToggler(dictationAvailable() ? toggle : null)
    return () => {
      setDictationFieldToggler(null)
      releaseDictationScope(scope)
    }
  }, [owner, scope])
  if (!dictationAvailable()) return null
  const label = on ? t('dictation.stop') : t('dictation.start')
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={on}
        data-field-mic={on ? 'on' : 'off'}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          const s = useDictationStore.getState()
          if (s.phase !== 'idle' && s.scope === scope) stopDictation()
          else void startDictation({ kind: 'field', owner, insert: (text) => cbs.current.insert(text), before: () => cbs.current.before() })
        }}
        className={cn(
          'relative rounded p-1 transition-colors hover:bg-bg-secondary',
          on ? 'text-red-400 hover:text-red-400' : 'text-text-secondary hover:text-text-primary',
        )}
      >
        <Mic size={14} />
        {on && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-red-400 motion-reduce:animate-none" />}
      </button>
    </Tooltip>
  )
}

/** One line under the field: what is being heard, the slow or fallback notice, or an error with its way out. */
export function FieldDictationStatus({ owner }: { owner: string }) {
  const t = useT()
  const st = useScope(`field:${owner}`)
  if (!st.on && !st.error) return null
  const fallback = fallbackKey(st.fallback)
  return (
    <div data-field-dictation={owner} className="flex items-center gap-2 text-xs text-text-secondary">
      {st.on ? <Mic size={12} className="shrink-0 text-red-400" /> : <MicOff size={12} className="shrink-0" />}
      <span data-dictation-interim className={cn('min-w-0 flex-1 truncate', st.error && !st.on && 'text-red-400')}>
        {st.error
          ? t(errorKey(st.error))
          : st.interim ||
            (st.slow
              ? t('dictation.startingSlow')
              : fallback
                ? t(fallback)
                : t(st.phase === 'starting' ? 'dictation.starting' : st.phase === 'stopping' ? 'dictation.stopping' : 'dictation.listening'))}
      </span>
      {st.error && <ErrorActionButton code={st.error} />}
    </div>
  )
}
