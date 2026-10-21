import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { formatAgeShort } from '@shared/agents'
import type { RemoteNote } from '@shared/remote-protocol'
import type { ShareGuestNotesRes, ShareLinkView } from '@shared/share-guest'
import type { WsNoteMeta } from '@shared/ws-notes'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { useShareGuestStore } from '@/lib/shareGuestStore'
import { liveKeyOf, useShareExtrasStore } from '@/lib/shareGuestExtras'
import { SharedMarkdown } from './chat/Markdown'

type Err = 'noReply' | 'gone' | 'failed'

/** How a notes answer failed, for the drawer's copy. */
function notesError(res: ShareGuestNotesRes): Err | null {
  if (res.ok && res.reply?.ok) return null
  if (!res.ok) return res.error === 'denied' || res.error === 'invalid' ? 'failed' : 'noReply'
  const e = res.reply?.error
  return e === 'rate' ? 'noReply' : e === 'not_found' ? 'gone' : 'failed'
}

const ERR_KEY: Record<Err, MessageKey> = {
  noReply: 'shareGuest.extras.noReply',
  gone: 'shareGuest.notes.gone',
  failed: 'shareGuest.notes.failed',
}

/**
 * The Notes of a shared workspace, read only (app 2.4.0, item 8, S5): the
 * host's list on the left, the picked note as Markdown on the right (links
 * through ConfirmLinkDialog). There is no editor: writes, creates and
 * deletes do not exist in the share protocol. A `notesChanged` from the host
 * reloads the list, and the open note when it is the one that changed.
 */
export function SharedNotesView({ link, hostLabel }: { link: ShareLinkView; hostLabel: string }) {
  const t = useT()
  const lang = useLang()
  const linkId = link.id
  const liveKey = liveKeyOf(link)
  const seq = useShareExtrasStore((s) => s.notesSeq[linkId])
  const confirmLink = useShareGuestStore((s) => s.confirmLink)
  const [notes, setNotes] = useState<WsNoteMeta[] | null>(null)
  const [listErr, setListErr] = useState<Err | null>(null)
  const [listBusy, setListBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [note, setNote] = useState<RemoteNote | null>(null)
  const [noteErr, setNoteErr] = useState<Err | null>(null)
  const [noteBusy, setNoteBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadList = useCallback(async () => {
    setListBusy(true)
    const res = await window.snApi.share.guest.notes({ linkId, op: 'list' }).catch((): ShareGuestNotesRes => ({ ok: false, error: 'offline' }))
    if (!alive.current) return
    setListBusy(false)
    const err = notesError(res)
    setListErr(err)
    if (!err) setNotes([...(res.reply?.notes ?? [])].sort((a, b) => b.updatedAt - a.updatedAt))
  }, [linkId])

  const loadNote = useCallback(
    async (id: string) => {
      setNoteBusy(true)
      const res = await window.snApi.share.guest.notes({ linkId, op: 'read', noteId: id }).catch((): ShareGuestNotesRes => ({ ok: false, error: 'offline' }))
      if (!alive.current) return
      setNoteBusy(false)
      const err = notesError(res)
      setNoteErr(err)
      setNote(err ? null : (res.reply?.note ?? null))
    },
    [linkId],
  )

  useEffect(() => {
    if (liveKey !== null) void loadList()
  }, [liveKey, loadList])

  const lastSeq = useRef(seq?.n ?? 0)
  useEffect(() => {
    const n = seq?.n ?? 0
    if (n === lastSeq.current) return
    lastSeq.current = n
    void loadList()
    if (openId && (!seq?.noteId || seq.noteId === openId)) void loadNote(openId)
  }, [seq, openId, loadList, loadNote])

  const open = (id: string): void => {
    setOpenId(id)
    setNote(null)
    void loadNote(id)
  }

  const now = Date.now()
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-shared-notes>
      <div className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="min-h-0 flex-1 overflow-y-auto py-1" data-shared-notes-list>
          {notes === null && listBusy && (
            <div className="flex justify-center py-6 text-text-secondary">
              <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-label={t('shareGuest.notes.loading')} />
            </div>
          )}
          {listErr && (
            <div className="space-y-2 px-3 py-3 text-xs text-text-secondary" data-shared-notes-error={listErr}>
              <p>{t(ERR_KEY[listErr])}</p>
              <button type="button" onClick={() => void loadList()} className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card">
                {t('shareGuest.extras.retry')}
              </button>
            </div>
          )}
          {notes?.length === 0 && !listErr && <p className="px-3 py-3 text-xs text-text-secondary">{t('shareGuest.notes.empty')}</p>}
          {notes?.map((n) => (
            <button
              key={n.id}
              type="button"
              data-shared-note={n.id}
              aria-current={openId === n.id ? 'true' : undefined}
              onClick={() => open(n.id)}
              className={cn(
                'flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-card',
                openId === n.id && 'bg-card',
              )}
            >
              <span className="truncate text-xs text-text-primary">{n.title || t('wsnotes.untitled')}</span>
              <span className="text-[10px] text-text-secondary">{formatAgeShort(Math.max(0, now - n.updatedAt), lang)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4" data-shared-note-view={openId ?? ''}>
        {!openId ? (
          <p className="pt-6 text-center text-sm text-text-secondary">{t('shareGuest.notes.pick')}</p>
        ) : noteErr ? (
          <div className="space-y-2 pt-6 text-center text-sm text-text-secondary" data-shared-note-error={noteErr}>
            <p>{t(ERR_KEY[noteErr])}</p>
            {noteErr === 'noReply' && (
              <button type="button" onClick={() => void loadNote(openId)} className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card">
                {t('shareGuest.extras.retry')}
              </button>
            )}
          </div>
        ) : !note ? (
          noteBusy ? (
            <div className="flex justify-center pt-6 text-text-secondary">
              <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-label={t('shareGuest.notes.loading')} />
            </div>
          ) : null
        ) : (
          <>
            {note.readOnly && (
              <p data-shared-note-partial className="mb-3 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
                {t('shareGuest.notes.partial')}
              </p>
            )}
            <SharedMarkdown text={note.text ?? ''} onLink={(href) => confirmLink(href, hostLabel)} />
          </>
        )}
      </div>
    </div>
  )
}
