import { useCallback, useEffect, useMemo, useState } from 'react'
import { teamPaneId } from '@shared/teams'
import type { RunView } from '@shared/team-protocol'
import { useT } from '@/i18n'
import { EMPTY_RUN_CHAT, runChatFirst, runChatForget, runChatMore, useRunChatStore, wordRunList } from '@/lib/teams/runChat'
import { ChatScroller, type ChatScrollerState, type ChatScrollerTexts } from '@/components/chat/ChatScroller'
import { safeHref } from '@/components/chat/chatModel'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

const LOADING: ChatScrollerState = { ...EMPTY_RUN_CHAT, loading: 'first' }

/**
 * The log of one team run as a chat (app 2.7.0, E10 B2): the console chat's
 * ChatScroller (A7) over the run's RunLog pages, with "Load earlier" and the
 * lines main pushes while the run is watched (lib/teams/runChat.ts). Read
 * only. A link an agent wrote opens in the browser only after a confirm that
 * shows its whole target, and only for http(s). RunLog's cut row shows in the
 * UI language (`wordRunList`).
 */
export function RunChatView({ teamId, runId, run, agentName }: { teamId: string; runId: string; run?: RunView; agentName: string }) {
  const t = useT()
  const chat = useRunChatStore((s) => s.chats[runId])
  const [link, setLink] = useState<string | null>(null)

  useEffect(() => {
    runChatFirst(teamId, runId)
    return () => runChatForget(runId)
  }, [teamId, runId])

  const onMore = useCallback(() => runChatMore(runId), [runId])
  const onRetryFirst = useCallback(() => runChatFirst(teamId, runId), [teamId, runId])
  const onLink = useCallback((href: string) => {
    const safe = safeHref(href)
    if (safe) setLink(safe)
  }, [])
  const texts = useMemo<ChatScrollerTexts>(
    () => ({ log: t('teams.run.chat.log'), capped: t('teams.run.chat.capped'), noReply: t('teams.run.chat.noReply'), outputCut: t('teams.run.chat.outputCut') }),
    [t],
  )
  const cut = t('teams.run.chat.cut')
  const held = chat?.list
  // Worded once per list or language: a patch of the run alone keeps the rows ChatScroller built.
  const list = useMemo(() => (held ? wordRunList(held, cut) : null), [held, cut])
  const shown = useMemo<ChatScrollerState>(() => {
    if (!chat || !list) return LOADING
    return list === chat.list ? chat : { ...chat, list }
  }, [chat, list])
  const state = run?.state ?? chat?.run?.state
  return (
    <>
      <ChatScroller
        key={runId}
        paneId={teamPaneId(runId)}
        chat={shown}
        working={state === 'starting' || state === 'running'}
        agent={agentName}
        onMore={onMore}
        onRetryFirst={onRetryFirst}
        onLink={onLink}
        texts={texts}
      />
      <ConfirmDialog
        open={link !== null}
        title={t('teams.run.link.title')}
        message={t('teams.run.link.msg', { href: link ?? '' })}
        confirmLabel={t('teams.run.link.yes')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          const href = link ? safeHref(link) : null
          setLink(null)
          if (href) window.snApi.system.openExternal(href)
        }}
        onCancel={() => setLink(null)}
      />
    </>
  )
}
