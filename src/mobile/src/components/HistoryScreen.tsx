/**
 * History (E3-FR-36..39), a pushed screen opened from a workspace's menu on
 * Home or from the terminal's kebab. Two tabs: "This workspace" (sessions
 * whose cwd is the workspace's or one of its consoles', main decides) and
 * "All projects". The search box asks again 250ms after the last keystroke;
 * main filters by title and last message and answers at most 100 sessions.
 *
 * A card opens a confirmation: "Opens in <workspace>, folder <cwd>" with
 * [Resume in a new console] (createPane with `resume`). A session the desktop
 * says is already open offers [Go to the console] instead, and a resume the
 * desktop answers with an existing console goes there as well. A request
 * without an answer in 10s (or over the rate limit) shows "The PC did not
 * answer [Retry]" (E3-FR-04).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2, Search } from 'lucide-react'
import type { RemoteHistorySession } from '@shared/remote-protocol'
import { PushScreen } from './PushScreen'
import { Sheet } from './Sheet'
import { NoReply } from './NoReply'
import { HistoryCard } from './HistoryCard'
import { store, useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { isNoReply } from '../lib/pending'
import { paneById } from '../lib/workspace'
import { STATUS_TICK_MS } from '../lib/statusText'
import {
  closeHistory,
  HISTORY_DEBOUNCE_MS,
  historyRequest,
  openPaneOf,
  useHistoryStore,
  type HistoryTab,
} from '../lib/history'
import { t } from '../lib/i18n'

type ListState = { status: 'loading' | 'ok' | 'noReply'; sessions: RemoteHistorySession[] | null }

/** Open a console after History closed: a listed one through requestOpen, a brand new one at once. */
function goToConsole(paneId: string): void {
  const snap = store.getState().snapshot
  if (snap && paneById(snap, paneId)) client.requestOpen(paneId)
  else client.showPane(paneId)
}

/** The confirmation of one card (E3-FR-38/39). */
function ResumeSheet({
  session,
  workspaceId,
  onClose,
  onDone,
}: {
  session: RemoteHistorySession | null
  workspaceId: string
  onClose: () => void
  onDone: (paneId: string) => void
}): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const [busy, setBusy] = useState(false)
  // A second tap before the re-render must not resume twice.
  const inFlight = useRef(false)
  const [noReply, setNoReply] = useState(false)
  // Keep the content through the exit animation, after the parent cleared it.
  const last = useRef<RemoteHistorySession | null>(null)
  if (session) last.current = session
  const shown = session ?? last.current

  useEffect(() => {
    if (!session) return
    setBusy(false)
    setNoReply(false)
  }, [session])

  const wsName = snapshot?.workspaces.find((w) => w.id === workspaceId)?.name ?? ''
  const openPaneId = shown ? openPaneOf(snapshot, shown) : null
  const openPane = openPaneId && snapshot ? paneById(snapshot, openPaneId) : null

  const resume = async (): Promise<void> => {
    if (!session || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNoReply(false)
    const known = new Set((store.getState().snapshot?.workspaces ?? []).flatMap((w) => w.panes.map((p) => p.id)))
    const res = await client.sendCtl({
      kind: 'createPane',
      workspaceId,
      paneType: session.provider,
      resume: { provider: session.provider, sessionId: session.sessionId },
    })
    inFlight.current = false
    setBusy(false)
    if (res.ok && res.paneId) {
      // E3-FR-38: the desktop answered with the console that already holds it.
      if (known.has(res.paneId)) {
        const title = paneById(store.getState().snapshot!, res.paneId)?.title ?? ''
        store.getState().setToast(t('history.alreadyOpen', { pane: title }))
      }
      onDone(res.paneId)
      return
    }
    if (isNoReply(res.error)) {
      setNoReply(true)
      return
    }
    store.getState().setToast(t(res.error === 'notFound' ? 'history.notFound' : 'history.resumeFailed'))
    onClose()
  }

  return (
    <Sheet open={session != null} onClose={onClose} title={shown?.title ?? t('history.title')}>
      <div data-history-sheet={shown?.sessionId ?? ''} className="flex flex-col gap-4">
        <p data-history-opens className="break-words text-sm leading-relaxed text-text-secondary">
          {openPane ? t('history.alreadyOpen', { pane: openPane.title }) : t('history.opensIn', { workspace: wsName, cwd: shown?.cwd ?? '' })}
        </p>
        {noReply && <NoReply onRetry={() => void resume()} />}
        {openPaneId ? (
          <button
            type="button"
            data-history-goto
            onClick={() => onDone(openPaneId)}
            className="h-12 w-full rounded-btn bg-accent-violet text-sm font-semibold text-white active:opacity-90"
          >
            {t('history.goTo')}
          </button>
        ) : (
          <button
            type="button"
            data-history-resume
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void resume()}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-btn bg-accent-violet text-sm font-semibold text-white active:opacity-90 disabled:opacity-60"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {t('history.resume')}
          </button>
        )}
      </div>
    </Sheet>
  )
}

/** The screen body, mountable without the PushScreen chrome (tests). */
export function HistoryBody({ workspaceId, onGo }: { workspaceId: string; onGo: (paneId: string) => void }): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const [tab, setTab] = useState<HistoryTab>('workspace')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [round, setRound] = useState(0)
  const [list, setList] = useState<ListState>({ status: 'loading', sessions: null })
  const [selected, setSelected] = useState<RemoteHistorySession | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), HISTORY_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    let cancelled = false
    setList((prev) => ({ status: 'loading', sessions: prev.sessions }))
    void client.requestHistory(historyRequest(tab, debounced, workspaceId)).then((out) => {
      if (cancelled) return
      if (out.ok) {
        setList({ status: 'ok', sessions: out.value })
        setNow(Date.now())
      } else setList((prev) => ({ status: 'noReply', sessions: prev.sessions }))
    })
    return () => {
      cancelled = true
    }
  }, [tab, debounced, workspaceId, round])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), STATUS_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const sessions = list.sessions ?? []
  const q = debounced.trim()

  return (
    <div data-history-body={workspaceId} data-history-status={list.status} className="flex flex-col gap-3">
      <div role="tablist" className="flex gap-1 rounded-btn border border-border bg-bg-secondary p-1">
        {(['workspace', 'all'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-history-tab={id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={clsx(
              'h-9 flex-1 rounded-btn text-xs font-medium',
              tab === id ? 'bg-accent-violet text-white' : 'text-text-secondary active:bg-card',
            )}
          >
            {t(id === 'workspace' ? 'history.tabWorkspace' : 'history.tabAll')}
          </button>
        ))}
      </div>
      <label className="flex h-11 items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3 focus-within:border-accent-violet">
        <Search size={16} className="shrink-0 text-text-secondary" />
        <input
          type="search"
          data-history-search
          value={query}
          maxLength={200}
          placeholder={t('history.search')}
          aria-label={t('history.search')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-base text-text-primary outline-none"
        />
        {list.status === 'loading' && list.sessions && <Loader2 size={16} className="shrink-0 animate-spin text-text-secondary" />}
      </label>

      {list.status === 'noReply' && <NoReply onRetry={() => setRound((r) => r + 1)} />}

      {list.status === 'loading' && !list.sessions ? (
        <div data-history-loading className="flex items-center justify-center gap-2 py-8 text-sm text-text-secondary">
          <Loader2 size={18} className="animate-spin" />
          {t('history.loading')}
        </div>
      ) : list.sessions && sessions.length === 0 ? (
        <p data-history-empty className="py-8 text-center text-sm text-text-secondary">
          {q ? t('history.noMatch', { query: q }) : t('history.empty')}
        </p>
      ) : (
        <div data-history-list className="flex flex-col gap-2">
          {sessions.map((s) => (
            <HistoryCard key={`${s.provider}:${s.sessionId}`} session={s} now={now} open={!!openPaneOf(snapshot, s)} onSelect={setSelected} />
          ))}
          {sessions.length > 0 && <p className="px-1 pt-1 text-center text-[11px] text-text-secondary">{t('history.more')}</p>}
        </div>
      )}

      <ResumeSheet
        session={selected}
        workspaceId={workspaceId}
        onClose={() => setSelected(null)}
        onDone={(paneId) => {
          setSelected(null)
          onGo(paneId)
        }}
      />
    </div>
  )
}

export function HistoryScreen(): ReactNode {
  const workspaceId = useHistoryStore((s) => s.workspaceId)
  const exists = useRemoteStore((s) => !!workspaceId && !!s.snapshot?.workspaces.some((w) => w.id === workspaceId))
  // The workspace History belongs to went away on the desktop: nothing to resume into.
  useEffect(() => {
    if (workspaceId && !exists && store.getState().snapshot) closeHistory()
  }, [workspaceId, exists])
  // The last workspace keeps the body mounted through the slide out.
  const last = useRef<string | null>(null)
  if (workspaceId) last.current = workspaceId
  const shownWs = workspaceId ?? last.current
  return (
    <PushScreen id="history" open={workspaceId != null} onClose={closeHistory} title={t('history.title')}>
      {shownWs && (
        <HistoryBody
          key={shownWs}
          workspaceId={shownWs}
          onGo={(paneId) => {
            closeHistory()
            goToConsole(paneId)
          }}
        />
      )}
    </PushScreen>
  )
}
