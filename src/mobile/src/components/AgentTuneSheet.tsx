/**
 * Model, effort and Ultracode of the console open on the phone (app 2.3.0,
 * ctl `agentTune`). Opened from a chip in the terminal header ("opus · high ·
 * UC") or the kebab's "Model and effort" row, only for a Claude or Codex
 * console of a desktop >= 2.3.0 (an older one strikes the unknown ctl).
 *
 * Claude: model chips (the line under them says `/model` also saves the
 * default for new sessions), a 5-stop effort control low..max plus Auto, and
 * the Ultracode switch. Codex: the values it reported (read-only) and "Open
 * model picker" (`/model`; the user picks with the KeyBar arrows and Enter).
 *
 * Every tap is one command. "Apply with Enter" (off by default, per phone in
 * 'snagentsos.tune.enter'): off, Composer mode inserts it at the caret and
 * Direct mode types it without Enter (`enter:false`); on, the desktop applies
 * it only on a precise, idle agent with nothing unsent in its box, else
 * `busy` and the sheet offers to insert it instead. The controls are locked
 * while a ctl is in flight.
 */
import { useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2, SlidersHorizontal } from 'lucide-react'
import { CLAUDE_EFFORTS, CLAUDE_MODELS, tuneCommand, type TuneSet } from '@shared/agentTune'
import { Sheet } from './Sheet'
import { selectInputMode, store, useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { getComposerHandle } from '../lib/terminalBus'
import { paneById, workspaceOfPane } from '../lib/workspace'
import { loadTuneEnter, saveTuneEnter, tuneChipText, tuneProvider, tuneSupported } from '../lib/tune'
import { t, type MobileMessageKey } from '../lib/i18n'

const ERRORS: Record<string, MobileMessageKey> = {
  not_found: 'tune.err.notFound',
  not_running: 'tune.err.notRunning',
  not_agent: 'tune.err.unsupported',
  unsupported: 'tune.err.unsupported',
  rate: 'tune.err.rate',
}

/** The console open on the phone when it can be tuned: its workspace and provider. */
export function useTuneTarget(paneId: string | null): { workspaceId: string; paneId: string; provider: 'claude' | 'codex' } | null {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const status = useRemoteStore((s) => (paneId ? s.paneStatus[paneId] : undefined))
  const appVersion = useRemoteStore((s) => s.appVersion)
  if (!paneId || !snapshot || !tuneSupported(appVersion)) return null
  const pane = paneById(snapshot, paneId)
  const workspaceId = workspaceOfPane(snapshot, paneId)
  const provider = tuneProvider(pane?.type, status)
  return pane && workspaceId && provider ? { workspaceId, paneId, provider } : null
}

/** Header chip of a tunable console: what it runs, or "Model" while unknown. */
export function AgentTuneChip({ paneId, onOpen }: { paneId: string; onOpen: () => void }): ReactNode {
  const target = useTuneTarget(paneId)
  const status = useRemoteStore((s) => s.paneStatus[paneId])
  if (!target) return null
  const text = tuneChipText(status)
  return (
    <button
      type="button"
      data-tune-chip={target.provider}
      onClick={onOpen}
      aria-label={t('tune.chipLabel', { value: text ?? t('tune.unknown') })}
      className="-my-1 flex h-7 max-w-[96px] shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[10px] leading-4 text-text-secondary active:bg-card"
    >
      <SlidersHorizontal size={11} className="shrink-0" />
      <span className="min-w-0 truncate">{text ?? t('tune.chip')}</span>
    </button>
  )
}

function Switch({ on, label, hint, onToggle, disabled, ...data }: { on: boolean; label: string; hint: string; onToggle: () => void; disabled?: boolean; [k: `data-${string}`]: string | boolean }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className="flex min-h-12 w-full items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2 text-left disabled:opacity-50"
      {...data}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm text-text-primary">{label}</span>
        <span className="text-[11px] text-text-secondary">{hint}</span>
      </span>
      <span className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', on ? 'bg-accent-violet' : 'bg-border')}>
        <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform', on ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </span>
    </button>
  )
}

const chip = (on: boolean): string =>
  clsx(
    'min-h-10 rounded-btn border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50',
    on ? 'border-accent-violet bg-accent-violet text-white' : 'border-border bg-card text-text-primary active:bg-bg-primary',
  )

export function AgentTuneSheet({ paneId, open, onClose }: { paneId: string | null; open: boolean; onClose: () => void }): ReactNode {
  const target = useTuneTarget(paneId)
  const status = useRemoteStore((s) => (paneId ? s.paneStatus[paneId] : undefined))
  const [enter, setEnter] = useState(loadTuneEnter)
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<TuneSet | null>(null)
  // Read synchronously: a second tap can land before React re-renders `busy`.
  const inFlight = useRef(false)

  const close = (): void => {
    setRefused(null)
    onClose()
  }

  /** One tap: insert (Enter off) or ask the desktop to apply it (Enter on). */
  const run = async (set: TuneSet, withEnter: boolean): Promise<void> => {
    if (!target || inFlight.current) return
    const cmd = tuneCommand(target.provider, set)
    if (!cmd) return
    const s = store.getState()
    const composer = getComposerHandle()
    if (!withEnter && composer && selectInputMode(s) === 'composer' && composer.paneId() === target.paneId) {
      composer.insert(cmd)
      close()
      s.setToast(t('tune.inserted', { cmd }))
      return
    }
    inFlight.current = true
    setBusy(JSON.stringify(set))
    setRefused(null)
    const res = await client.sendCtl({ kind: 'agentTune', workspaceId: target.workspaceId, paneId: target.paneId, set, enter: withEnter })
    inFlight.current = false
    setBusy(null)
    if (!res.ok) {
      if (res.error === 'busy') setRefused(set)
      else store.getState().setToast(t(ERRORS[res.error ?? ''] ?? 'tune.err.generic'))
      return
    }
    close()
    store.getState().setToast(t(withEnter ? 'tune.applied' : 'tune.typed', { cmd }))
  }
  const tap = (set: TuneSet): void => void run(set, enter)
  const locked = busy !== null
  const spin = (set: TuneSet): ReactNode => (busy === JSON.stringify(set) ? <Loader2 size={12} className="ml-1 inline animate-spin" /> : null)

  const now = [status?.model, status?.effort, status?.ultracode ? t('tune.ultracodeOn') : undefined].filter(Boolean).join(' · ')

  return (
    <Sheet open={open && !!target} onClose={close} title={t('tune.title')}>
      {target && (
        <div data-tune-sheet={target.provider} className="flex flex-col gap-4" aria-busy={locked || undefined}>
          <p data-tune-now className="text-xs text-text-secondary">{t('tune.now', { value: now || t('tune.unknown') })}</p>
          {target.provider === 'claude' ? (
            <>
              <section data-tune-section="model" className="flex flex-col gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('tune.model')}</h3>
                <div role="radiogroup" aria-label={t('tune.model')} className="flex flex-wrap gap-2">
                  {CLAUDE_MODELS.map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={status?.model === m} data-tune-model={m} disabled={locked} onClick={() => tap({ kind: 'model', value: m })} className={chip(status?.model === m)}>
                      {m}
                      {spin({ kind: 'model', value: m })}
                    </button>
                  ))}
                </div>
                <p data-tune-model-note className="text-[11px] text-text-secondary">{t('tune.modelDefault')}</p>
              </section>
              <section data-tune-section="effort" className="flex flex-col gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('tune.effort')}</h3>
                <div className="flex items-stretch gap-2">
                  <div role="radiogroup" aria-label={t('tune.effort')} className="flex min-w-0 flex-1 overflow-hidden rounded-btn border border-border">
                    {CLAUDE_EFFORTS.map((level) => {
                      const on = status?.effort === level
                      return (
                        <button
                          key={level}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          data-tune-effort={level}
                          disabled={locked}
                          onClick={() => tap({ kind: 'effort', value: level })}
                          className={clsx('min-h-10 min-w-0 flex-1 border-r border-border px-1 text-[11px] font-medium last:border-r-0 disabled:opacity-50', on ? 'bg-accent-violet text-white' : 'bg-card text-text-primary active:bg-bg-primary')}
                        >
                          {level}
                          {spin({ kind: 'effort', value: level })}
                        </button>
                      )
                    })}
                  </div>
                  <button type="button" role="radio" aria-checked={status?.effort === 'auto'} data-tune-effort="auto" disabled={locked} onClick={() => tap({ kind: 'effort', value: 'auto' })} className={chip(status?.effort === 'auto')}>
                    {t('tune.auto')}
                    {spin({ kind: 'effort', value: 'auto' })}
                  </button>
                </div>
                <div className="flex justify-between text-[11px] text-text-secondary">
                  <span>{t('tune.faster')}</span>
                  <span>{t('tune.smarter')}</span>
                </div>
              </section>
              <Switch
                data-tune-ultracode
                on={status?.ultracode === true}
                label={t('tune.ultracode')}
                hint={t('tune.ultracodeHint')}
                disabled={locked}
                onToggle={() => tap({ kind: 'ultracode', on: status?.ultracode !== true })}
              />
            </>
          ) : (
            <section data-tune-codex className="flex flex-col gap-2">
              <p className="text-[11px] text-text-secondary">{t('tune.codexHint')}</p>
              <button
                type="button"
                data-tune-picker
                disabled={locked}
                onClick={() => tap({ kind: 'picker' })}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-btn border border-border bg-bg-secondary text-sm font-medium text-text-primary active:bg-card disabled:opacity-50"
              >
                {busy !== null && <Loader2 size={16} className="animate-spin" />}
                {t('tune.codexPicker')}
              </button>
            </section>
          )}
          {refused && (
            <div data-tune-busy role="alert" className="flex items-center gap-3 rounded-card border border-accent-violet/60 bg-accent-violet/10 px-3 py-2">
              <span className="min-w-0 flex-1 text-xs text-text-primary">{t('tune.busy')}</span>
              <button
                type="button"
                data-tune-insert
                disabled={locked}
                onClick={() => void run(refused, false)}
                className="min-h-10 shrink-0 rounded-btn bg-accent-violet px-3 text-xs font-semibold text-white active:opacity-90 disabled:opacity-50"
              >
                {t('tune.insert')}
              </button>
            </div>
          )}
          <Switch
            data-tune-enter
            on={enter}
            label={t('tune.enter')}
            hint={t('tune.enterHint')}
            onToggle={() => {
              const next = !enter
              setEnter(next)
              saveTuneEnter(next)
              setRefused(null)
            }}
          />
        </div>
      )}
    </Sheet>
  )
}
