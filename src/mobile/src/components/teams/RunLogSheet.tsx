/**
 * A team run's log on the phone (app 2.7.0, E10 B8): the run's chat as the
 * PC keeps it (`runPage`, newest page first, "Cargar anteriores" for the
 * earlier ones), with the phone's chat rows. Agent text is spelled out
 * (visibleText); the log cut and main's notes read in words, never as the
 * record main wrote. While the run is live, "Actualizar" reads the newest
 * page again. Read only: nothing here reaches the run.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import type { ChatMessage } from '@shared/chat-types'
import type { RunView } from '@shared/team-protocol'
import { Sheet } from '../Sheet'
import { NoReply } from '../NoReply'
import { MessageRow } from '../chat/MessageRow'
import { ToolPhaseRow, ToolRunRow } from '../chat/ToolRunRow'
import { GHOST_BTN, Spinner } from './TeamBits'
import { MODE_KEY, RUN_STATE_KEY, refusalOf, replyOf, runMessageOf, visibleName } from './teamText'
import { buildRows } from '../../lib/chatModel'
import { client } from '../../lib/client'
import { t } from '../../lib/i18n'

interface RunLogState {
  status: 'loading' | 'ok' | 'noReply' | 'gone'
  items: ChatMessage[]
  cursor: string | null
  done: boolean
  live: boolean
  run?: RunView
}

const EXPAND = { open: false, v: 0 }
const noActions = (): void => {}

function RunLog({ teamId, runId }: { teamId: string; runId: string }): ReactNode {
  const [log, setLog] = useState<RunLogState>({ status: 'loading', items: [], cursor: null, done: false, live: false })
  const [older, setOlder] = useState(false)
  const seq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const n = ++seq.current
    const out = await client.requestTeam({ op: 'runPage', teamId, runId })
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      const f = refusalOf(out)
      setLog((cur) => ({ ...cur, status: f?.error === 'not_found' ? 'gone' : 'noReply' }))
      return
    }
    setLog({ status: 'ok', items: ok.items, cursor: ok.cursor, done: ok.done, live: ok.live, run: ok.run })
  }, [teamId, runId])

  useEffect(() => {
    void load()
  }, [load])

  const loadOlder = async (): Promise<void> => {
    if (!log.cursor || older) return
    const n = seq.current
    setOlder(true)
    const out = await client.requestTeam({ op: 'runPage', teamId, runId, before: log.cursor })
    setOlder(false)
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      setLog((cur) => ({ ...cur, status: 'noReply' }))
      return
    }
    setLog((cur) => {
      const known = new Set(cur.items.map((m) => m.id))
      return { ...cur, status: 'ok', items: [...ok.items.filter((m) => !known.has(m.id)), ...cur.items], cursor: ok.cursor, done: ok.done }
    })
  }

  const rows = useMemo(() => buildRows(log.items.map(runMessageOf)), [log.items])
  const run = log.run
  if (log.status === 'gone') return <p className="py-8 text-center text-sm text-text-secondary">{t('teams.run.chat.noReply')}</p>
  return (
    <div data-run-sheet={runId} data-run-live={log.live ? 'true' : 'false'} className="flex min-w-0 flex-col gap-3 pb-2">
      {run && (
        <p data-run-header className="text-xs text-text-secondary">
          {t('teams.task.runLine', { agent: visibleName(run.agentId), mode: t(MODE_KEY[run.mode] ?? 'teams.mode.free') })} · {t(RUN_STATE_KEY[run.state] ?? 'teams.run.state.running')}
        </p>
      )}
      {log.status === 'noReply' && <NoReply onRetry={() => void load()} />}
      {log.status === 'loading' && log.items.length === 0 && <Spinner />}
      {log.cursor && !log.done && (
        <button type="button" data-run-older disabled={older} onClick={() => void loadOlder()} className={GHOST_BTN}>
          {older && <Loader2 size={16} className="spin" />}
          {t('teams.run.chat.older')}
        </button>
      )}
      {log.status === 'ok' && rows.length === 0 && <p className="py-4 text-center text-sm text-text-secondary">{t('teams.run.chat.empty')}</p>}
      <div className="-mx-4 flex min-w-0 flex-col gap-3">
        {rows.map((row) => (
          <div key={row.id} className="min-w-0">
            {row.kind === 'tools' ? (
              <ToolRunRow calls={row.calls} expandAll={EXPAND} />
            ) : row.kind === 'phase' ? (
              <ToolPhaseRow row={row} expandAll={EXPAND} />
            ) : (
              <MessageRow id={row.id} role={row.role} blocks={row.blocks} selectable onActions={noActions} />
            )}
          </div>
        ))}
      </div>
      {log.live && (
        <button type="button" data-run-refresh onClick={() => void load()} className={GHOST_BTN}>
          <RotateCcw size={16} />
          {t('teams.run.chat.refresh')}
        </button>
      )}
    </div>
  )
}

export function RunLogSheet({ teamId, runId, onClose }: { teamId: string; runId: string | null; onClose: () => void }): ReactNode {
  // Keep the run through the exit animation, after the parent cleared it.
  const last = useRef<string | null>(null)
  if (runId) last.current = runId
  const shown = runId ?? last.current
  return (
    <Sheet open={runId != null} onClose={onClose} title={t('teams.run.chat.log')} dragFromContent={false}>
      {shown && <RunLog key={shown} teamId={teamId} runId={shown} />}
    </Sheet>
  )
}
