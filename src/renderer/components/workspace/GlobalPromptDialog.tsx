import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Flag, GitBranch, Loader2, Megaphone, Minus, Plus } from 'lucide-react'
import type { Workspace } from '@shared/types'
import type { MessageKey } from '@/i18n'
import { useAppStore } from '@/lib/store'
import { broadcastToWorkspace, promptTargetOf } from '@/lib/broadcastPrompt'
import {
  defaultRaceCounts,
  RACE_AGENTS,
  RACE_MAX,
  raceCountsOk,
  raceFitsHere,
  racePresets,
  raceTotal,
  raceWorkspaceName,
  startRace,
  type RaceAgent,
  type RaceCounts,
} from '@/lib/race'
import { MAX_PANES } from '@/lib/worktrees'
import { iconFor } from '@/lib/icons'
import { isFromToast, toast } from '@/lib/toast'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'
import { KeyHint } from '@/components/ui/KeyHint'
import { Tooltip } from '@/components/ui/Tooltip'
import { ariaKeyshortcuts } from '@/lib/keymap'
import { FieldDictationStatus, FieldMicButton } from '@/components/terminal/DictationControls'

const SEND_KEYS = ['Ctrl', 'Enter']
const AGENT_LABEL: Record<RaceAgent, string> = { claude: 'Claude', codex: 'Codex' }

type Mode = 'prompt' | 'race'
/** The repo check of race mode: the base commit, or why a race cannot start here. */
type Probe = { state: 'checking' } | { state: 'ok'; head: string; headShort: string } | { state: 'error'; error: 'not_repo' | 'unborn' | 'remote' }

/**
 * Global prompt (E7-FR-33) and race (E7-FR-34): mounted once at the app
 * level, gated on the store's `globalPromptOpen`, always over the ACTIVE
 * workspace.
 *
 * Prompt mode: one chip per active console (all on; a click turns one off)
 * and "Send with Enter" (off). The text goes through `term.paste`; plain
 * consoles get it on one line and never an Enter.
 *
 * Race mode: the same text is the task; counters per agent (at most 4 in
 * all, and no more than the free slots for "this workspace") and the
 * destination. Ctrl+Enter is the consent: it creates the worktrees from one
 * base sha and sends the task with Enter to each agent once it is ready.
 */
export function GlobalPromptDialog() {
  const open = useAppStore((s) => s.globalPromptOpen)
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
  if (!open || !workspace) return null
  return <PromptDialog key={workspace.id} workspace={workspace} />
}

function PromptDialog({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const setOpen = useAppStore((s) => s.setGlobalPromptOpen)
  const minimizedIds = useAppStore((s) => s.minimized[workspace.id]) ?? []
  const presetsList = useAppStore((s) => s.presets)
  const settings = useAppStore((s) => s.settings)
  const connections = useAppStore((s) => s.connections)
  const presets = racePresets({ presets: presetsList, settings })

  const [mode, setMode] = useState<Mode>('prompt')
  const [prompt, setPrompt] = useState('')
  // Dictation (app 2.4.0) inserts at the caret: the latest text and caret, ahead of React's render.
  const textRef = useRef<HTMLTextAreaElement>(null)
  const latest = useRef({ text: '', caret: 0 })
  const [caretSync, setCaretSync] = useState(0)
  const trackCaret = (): void => {
    const el = textRef.current
    if (el) latest.current = { text: el.value, caret: el.selectionEnd ?? el.value.length }
  }
  const insertDictated = (chunk: string): void => {
    const { text, caret } = latest.current
    const at = Math.min(caret, text.length)
    const next = text.slice(0, at) + chunk + text.slice(at)
    latest.current = { text: next, caret: at + chunk.length }
    setPrompt(next)
    setCaretSync((n) => n + 1)
  }
  useEffect(() => {
    const el = textRef.current
    if (!el || caretSync === 0) return
    el.setSelectionRange(latest.current.caret, latest.current.caret)
  }, [caretSync])
  const active = workspace.panes.filter((p) => !minimizedIds.includes(p.id))
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const [enter, setEnter] = useState(false)
  const [counts, setCounts] = useState<RaceCounts>(() => defaultRaceCounts(presets))
  const [destination, setDestination] = useState<'here' | 'new'>('here')
  const [probe, setProbe] = useState<Probe>({ state: 'checking' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosen = active.filter((p) => !off.has(p.id))
  const total = raceTotal(counts)
  const fitsHere = raceFitsHere(workspace.panes.length, counts)
  const dest = fitsHere ? destination : 'new'
  const raceName = raceWorkspaceName(prompt, t('race.workspacePrefix'))

  // Race mode checks the repo once: the base every worktree starts from.
  useEffect(() => {
    if (mode !== 'race') return
    const setup = workspace.setupId ? connections.find((c) => c.id === workspace.setupId)?.steps : undefined
    if (setup && setup.length > 0) {
      setProbe({ state: 'error', error: 'remote' })
      return
    }
    if (!workspace.cwd) {
      setProbe({ state: 'error', error: 'not_repo' })
      return
    }
    let live = true
    setProbe({ state: 'checking' })
    window.snApi.git
      .worktreeProbe(workspace.cwd)
      .then((r) => {
        if (!live) return
        setProbe(r.ok ? { state: 'ok', head: r.head, headShort: r.headShort } : { state: 'error', error: r.error === 'unborn' ? 'unborn' : 'not_repo' })
      })
      .catch(() => live && setProbe({ state: 'error', error: 'not_repo' }))
    return () => {
      live = false
    }
  }, [mode, workspace.cwd, workspace.setupId, connections])

  const canSend = prompt.trim().length > 0 && chosen.length > 0
  const canRace = !busy && prompt.trim().length > 0 && raceCountsOk(counts) && probe.state === 'ok' && RACE_AGENTS.every((a) => counts[a] === 0 || !!presets[a])

  const close = (): void => {
    if (!busy) setOpen(false)
  }
  const send = (): void => {
    if (!canSend) return
    const { sent: count, skipped } = broadcastToWorkspace(workspace, prompt.trim(), { paneIds: chosen.map((p) => p.id), enter })
    setOpen(false)
    // N is what actually received the text (live, non-minimized ptys); the
    // consoles waiting on the user (a permission or plan menu) got nothing.
    const body = skipped > 0 ? t(skipped === 1 ? 'toast.prompt.skippedOne' : 'toast.prompt.skippedMany', { count: skipped }) : undefined
    const opts = { dedupeKey: 'globalPrompt', ...(body ? { body } : {}) }
    const done = body ? toast.warning : toast.success
    if (count === 0) toast.warning(t('toast.prompt.none'), opts)
    else if (enter) done(t(count === 1 ? 'toast.prompt.enterOne' : 'toast.prompt.enterMany', { count }), opts)
    else done(t(count === 1 ? 'toast.prompt.one' : 'toast.prompt.many', { count }), opts)
  }
  const race = async (): Promise<void> => {
    if (!canRace) return
    setBusy(true)
    setError(null)
    const res = await startRace({ workspaceId: workspace.id, task: prompt, counts, destination: dest }).catch(() => null)
    setBusy(false)
    if (res?.ok) {
      setOpen(false)
      return
    }
    if (!res) setError(t('race.err.generic'))
    else if (res.error === 'worktree') setError(t('race.err.worktree', { detail: res.detail ?? '' }))
    else if (res.error === 'not_repo' || res.error === 'unborn' || res.error === 'remote' || res.error === 'full') setError(t(`race.err.${res.error}` as MessageKey))
    else setError(t('race.err.generic'))
  }
  const submit = (): void => {
    if (mode === 'prompt') send()
    else void race()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  const toggleChip = (id: string): void =>
    setOff((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const bump = (agent: RaceAgent, delta: number): void =>
    setCounts((c) => {
      const n = c[agent] + delta
      if (n < 0 || raceTotal(c) + delta > RACE_MAX) return c
      return { ...c, [agent]: n }
    })

  const free = Math.max(0, MAX_PANES - workspace.panes.length)
  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => {
        setMode(m)
        setError(null)
      }}
      className={cn('px-2.5 py-1', mode === m ? 'bg-accent-violet/15 text-text-primary' : 'text-text-secondary hover:text-text-primary')}
      data-global-prompt-mode={m}
    >
      {label}
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60" onClick={(e) => { if (!isFromToast(e)) close() }} />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]" data-global-prompt>
        <div className="space-y-4 p-5">
          <div className="flex items-center gap-2">
            {mode === 'prompt' ? <Megaphone size={16} className="text-accent-violet" /> : <Flag size={16} className="text-accent-violet" />}
            <h2 className="text-sm font-semibold text-text-primary">{t('globalPrompt.title')}</h2>
            <span className="flex-1" />
            <div role="radiogroup" aria-label={t('globalPrompt.mode')} className="flex overflow-hidden rounded-btn border border-border text-xs">
              {tab('prompt', t('globalPrompt.mode.prompt'))}
              {tab('race', t('globalPrompt.mode.race'))}
            </div>
          </div>

          <div className="relative">
            <textarea
              ref={textRef}
              autoFocus
              rows={5}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value)
                latest.current = { text: e.target.value, caret: e.target.selectionEnd ?? e.target.value.length }
              }}
              onSelect={trackCaret}
              placeholder={mode === 'prompt' ? t('globalPrompt.placeholder') : t('race.placeholder')}
              className="w-full resize-none rounded-btn border border-border bg-bg-primary px-3 py-2 pr-9 text-sm text-text-primary outline-none focus:border-accent-violet/60"
              data-global-prompt-text
            />
            <div className="absolute right-1.5 top-1.5">
              <FieldMicButton owner="globalPrompt" insert={insertDictated} before={() => latest.current.text.slice(0, latest.current.caret)} />
            </div>
          </div>
          <FieldDictationStatus owner="globalPrompt" />

          {mode === 'prompt' ? (
            <>
              {active.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('globalPrompt.targets')}</p>
                  <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto" data-global-prompt-chips>
                    {active.map((p) => {
                      const Icon = iconFor(p.icon)
                      const on = !off.has(p.id)
                      const plain = promptTargetOf(p) === 'plain'
                      const chip = (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleChip(p.id)}
                          className={cn(
                            'flex max-w-[180px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors',
                            on ? 'border-accent-violet/50 bg-accent-violet/10 text-text-primary' : 'border-border text-text-secondary line-through opacity-60',
                          )}
                          data-global-prompt-chip={p.id}
                          data-plain={plain ? '' : undefined}
                        >
                          <Icon size={12} style={{ color: p.color }} className="shrink-0" />
                          <span className="truncate">{p.title}</span>
                        </button>
                      )
                      return plain ? (
                        <Tooltip key={p.id} label={t('globalPrompt.plainTip')} side="top">
                          {chip}
                        </Tooltip>
                      ) : (
                        chip
                      )
                    })}
                  </div>
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-xs text-text-primary">
                <input type="checkbox" checked={enter} onChange={(e) => setEnter(e.target.checked)} className="accent-[var(--color-accent-violet)]" data-global-prompt-enter />
                {t('globalPrompt.enter')}
              </label>
              <div className="-mt-2 space-y-1">
                <p className="text-xs text-text-secondary/80" data-global-prompt-count>
                  {active.length > 0 ? t('globalPrompt.target', { count: chosen.length, total: active.length }) : t('globalPrompt.empty')}
                </p>
                <p className="text-xs text-text-secondary/60">{enter ? t('globalPrompt.enterHint') : t('globalPrompt.hint')}</p>
              </div>
            </>
          ) : (
            <div className="space-y-3" data-race-form>
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('race.agents')}</p>
                <div className="flex flex-wrap items-center gap-3">
                  {RACE_AGENTS.map((a) => {
                    const has = !!presets[a]
                    return (
                      <div key={a} className={cn('flex items-center gap-1.5 text-xs', !has && 'opacity-50')} data-race-counter={a}>
                        <span className="w-12 text-text-primary">{AGENT_LABEL[a]}</span>
                        <button
                          type="button"
                          aria-label={t('race.dec', { agent: AGENT_LABEL[a] })}
                          disabled={!has || counts[a] === 0}
                          onClick={() => bump(a, -1)}
                          className="rounded-btn border border-border p-0.5 text-text-secondary hover:text-text-primary disabled:opacity-40"
                          data-race-dec={a}
                        >
                          <Minus size={12} />
                        </button>
                        <span className="w-6 text-center font-mono text-text-primary" data-race-count={a}>
                          x{counts[a]}
                        </span>
                        <button
                          type="button"
                          aria-label={t('race.inc', { agent: AGENT_LABEL[a] })}
                          disabled={!has || total >= RACE_MAX}
                          onClick={() => bump(a, 1)}
                          className="rounded-btn border border-border p-0.5 text-text-secondary hover:text-text-primary disabled:opacity-40"
                          data-race-inc={a}
                        >
                          <Plus size={12} />
                        </button>
                        {!has && <span className="text-[11px] text-text-secondary">{t('race.noPreset', { agent: AGENT_LABEL[a] })}</span>}
                      </div>
                    )
                  })}
                  <span className="text-[11px] text-text-secondary">{t('race.total', { count: total, max: RACE_MAX })}</span>
                </div>
              </div>

              <div className="space-y-1.5" role="radiogroup" aria-label={t('race.dest')}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('race.dest')}</p>
                <label className={cn('flex items-center gap-2 text-xs', fitsHere ? 'text-text-primary' : 'text-text-secondary/60')}>
                  <input type="radio" name="race-dest" checked={dest === 'here'} disabled={!fitsHere} onChange={() => setDestination('here')} className="accent-[var(--color-accent-violet)]" data-race-dest="here" />
                  {t('race.dest.here')}
                  {!fitsHere && <span className="text-[11px]">({t('race.dest.hereFull', { free })})</span>}
                </label>
                <label className="flex min-w-0 items-center gap-2 text-xs text-text-primary">
                  <input type="radio" name="race-dest" checked={dest === 'new'} onChange={() => setDestination('new')} className="accent-[var(--color-accent-violet)]" data-race-dest="new" />
                  <span className="truncate">{t('race.dest.new', { name: raceName })}</span>
                </label>
              </div>

              <p className="flex items-center gap-1.5 text-xs" data-race-probe={probe.state}>
                {probe.state === 'checking' && (
                  <>
                    <Loader2 size={12} className="animate-spin text-text-secondary" />
                    <span className="text-text-secondary">{t('race.checking')}</span>
                  </>
                )}
                {probe.state === 'ok' && (
                  <>
                    <GitBranch size={12} className="text-accent-violet" />
                    <span className="text-text-secondary">{t('race.base', { sha: probe.headShort })}</span>
                  </>
                )}
                {probe.state === 'error' && <span className="text-state-error">{t(`race.err.${probe.error}` as MessageKey)}</span>}
              </p>
              <p className="text-xs text-text-secondary/60">{t('race.hint', { count: total })}</p>
              {error && (
                <p role="alert" className="rounded-btn border border-state-error/40 bg-state-error/10 px-3 py-2 text-xs text-state-error" data-race-error>
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            onClick={close}
            disabled={busy}
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          {mode === 'prompt' ? (
            <button
              onClick={send}
              disabled={!canSend}
              aria-keyshortcuts={ariaKeyshortcuts(SEND_KEYS)}
              data-global-prompt-send
              className="inline-flex items-center gap-2 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('globalPrompt.send')}
              <KeyHint keys={SEND_KEYS} tone="onAccent" />
            </button>
          ) : (
            <button
              onClick={() => void race()}
              disabled={!canRace}
              aria-keyshortcuts={ariaKeyshortcuts(SEND_KEYS)}
              data-race-start
              className="inline-flex items-center gap-2 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {t('race.start')}
              <KeyHint keys={SEND_KEYS} tone="onAccent" />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
