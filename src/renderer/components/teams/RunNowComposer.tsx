import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { RUN_NOW_PROMPT_MAX } from '@shared/teams'
import type { AgentView } from '@shared/team-protocol'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { agentLabel, composeTaken, runFailText, runNow, useRosterStore } from '@/lib/teams/roster'
import { Button } from '@/components/ui/Button'

/** C0 except tab and newline, and DEL: main refuses a request body that has one (team-protocol-schemas BODY_BAD_RE). */
const BODY_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
const SEND_KEYS = ['Ctrl', 'Enter']

/** teamId/agentId -> the unsent request while the drawer is closed (this session only, never stored). */
const drafts = new Map<string, string>()

/** Why this agent cannot take a request now, as the key of the line that says so (null: it can). */
function blockedKey(agent: AgentView, trusted: boolean): MessageKey | null {
  if (!trusted) return 'teams.run.composer.untrusted'
  if (agent.retired) return 'teams.run.composer.retired'
  if (agent.takeover || agent.status === 'takenOver') return 'teams.run.composer.inConsole'
  if (agent.status === 'running') return 'teams.run.composer.busy'
  return null
}

/**
 * The composer of "Ejecutar ahora" (app 2.7.0, E10 B2), at the foot of the
 * agent drawer. Enter is a new line; only [Ejecutar ahora] or Ctrl+Enter
 * sends. The text goes to main in `runNow`, which hands it to the new run's
 * stdin as the user's request: never argv, never a pty, never typed into a
 * console. Main may still refuse it (a gate): the line under the box says
 * why ("Ahora no: el equipo está en pausa"). The draft outlives a close of
 * the drawer (in memory only).
 */
export function RunNowComposer({ teamId, agent, trusted }: { teamId: string; agent: AgentView; trusted: boolean }) {
  const t = useT()
  const lang = useLang()
  const key = `${teamId}/${agent.id}`
  const name = agentLabel(agent)
  const [draft, setDraftState] = useState(() => drafts.get(key) ?? '')
  const draftRef = useRef(draft)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  const compose = useRosterStore((s) => s.compose === agent.id)

  // "Ejecutar ahora" on the card: the box takes the keyboard (once).
  useEffect(() => {
    if (!compose) return
    boxRef.current?.focus()
    composeTaken(agent.id)
  }, [compose, agent.id])

  const setDraft = (value: string): void => {
    draftRef.current = value
    if (value) drafts.set(key, value)
    else drafts.delete(key)
    setDraftState(value)
  }

  const blocked = blockedKey(agent, trusted)
  const text = draft.trim()
  const control = BODY_BAD_RE.test(text)
  const canSend = !busy && !blocked && text !== '' && !control

  const submit = async (): Promise<void> => {
    if (!canSend) return
    const sent = draft
    setBusy(true)
    setNote(null)
    const fail = await runNow(teamId, agent.id, text)
    setBusy(false)
    if (fail) {
      setNote({ text: runFailText(fail, name, t, lang, Date.now()), error: true })
      return
    }
    // What was typed while it went stays for the next request.
    if (draftRef.current === sent) setDraft('')
    setNote({ text: t('teams.run.composer.started'), error: false })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    void submit()
  }

  const line = blocked ? t(blocked, { agent: name }) : control ? t('teams.run.composer.control') : (note?.text ?? t('teams.run.composer.hint'))
  const lineKind = blocked ? 'blocked' : control ? 'control' : note ? (note.error ? 'error' : 'ok') : 'hint'
  return (
    <div data-run-now-composer={agent.id} className="shrink-0 border-t border-border bg-bg-secondary/40 px-3 py-2">
      <textarea
        ref={boxRef}
        data-run-now-input
        value={draft}
        rows={3}
        maxLength={RUN_NOW_PROMPT_MAX}
        aria-label={t('teams.run.composer.label', { agent: name })}
        placeholder={t('teams.run.composer.placeholder', { agent: name })}
        spellCheck={false}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setDraft(e.target.value)
          if (note) setNote(null)
        }}
        className="block max-h-48 min-h-[4rem] w-full resize-none rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.4] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/50"
      />
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
        <p
          data-run-now-note={lineKind}
          role="status"
          className={cn('min-w-0 flex-1 text-[11px] leading-4', lineKind === 'error' || lineKind === 'control' ? 'text-state-error' : 'text-text-secondary')}
        >
          {line}
        </p>
        <Button size="sm" data-run-now-send disabled={!canSend} keyHint={SEND_KEYS} onClick={() => void submit()} className="h-8">
          {busy ? t('teams.run.composer.sending') : t('teams.run.composer.send')}
        </Button>
      </div>
    </div>
  )
}
