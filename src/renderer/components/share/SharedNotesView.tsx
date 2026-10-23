import { useCallback, useEffect, useRef, useState } from 'react'
import { Columns2, Eye, FilePlus2, Loader2, PencilLine, Trash2 } from 'lucide-react'
import { formatAgeShort } from '@shared/agents'
import type { RemoteNote } from '@shared/remote-protocol'
import type { ShareGuestNotesReq, ShareGuestNotesRes, ShareLinkView } from '@shared/share-guest'
import type { WsNoteMeta } from '@shared/ws-notes'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useShareGuestStore } from '@/lib/shareGuestStore'
import { liveKeyOf, useShareExtrasStore } from '@/lib/shareGuestExtras'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { useEditorLook } from '@/components/editor/useEditorLook'
import { NOTE_SAVE_DEBOUNCE_MS, loadNoteMode, saveNoteMode, type NoteMode } from '@/components/notes/noteMode'
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

interface Open {
  id: string
  /** Bumped on every (re)load: a new editor document. */
  seq: number
  initial: string
  rev: string
  /** Only its start came (past 40000 bytes): never editable from a share. */
  partial: boolean
}

/**
 * The Notes of a shared workspace (app 2.4.0, item 8, S5): the host's list on
 * the left, the picked note on the right. Read only, as Markdown (links
 * through ConfirmLinkDialog), unless this guest may write notes (app 2.6.0,
 * `caps.notesWrite`): then New, Delete and the editor with Edit / Split /
 * Preview, saved 600 ms after the last keystroke with the rev it loaded (one
 * save in flight). A note changed on the host meanwhile is a conflict
 * (Reload / Keep mine). A long note (only its start came) stays read-only.
 * A `notesChanged` reloads the list, and the open note when it is clean (the
 * echo of its own save is skipped by rev).
 */
export function SharedNotesView({ link, hostLabel, canWrite = false }: { link: ShareLinkView; hostLabel: string; canWrite?: boolean }) {
  const t = useT()
  const lang = useLang()
  const look = useEditorLook()
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
  const [open, setOpen] = useState<Open | null>(null)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<NoteMode>(loadNoteMode)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const alive = useRef(true)
  // Refs for the async paths (debounced save, change events).
  const openRef = useRef<Open | null>(null)
  openRef.current = open
  const textRef = useRef(text)
  textRef.current = text
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Saves run one after another: a switch waits for the one in flight. */
  const chain = useRef<Promise<void>>(Promise.resolve())
  const inFlight = useRef(false)
  /**
   * A change of the open note announced while a save was in flight: the host
   * sends it before the save's answer, so it is judged once the rev is known
   * (its own echo is skipped). undefined = none.
   */
  const deferred = useRef<string | null | undefined>(undefined)
  const docSeq = useRef(0)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const request = useCallback(
    (req: Omit<ShareGuestNotesReq, 'linkId'>): Promise<ShareGuestNotesRes> => window.snApi.share.guest.notes({ linkId, ...req }).catch((): ShareGuestNotesRes => ({ ok: false, error: 'offline' })),
    [linkId],
  )

  const loadList = useCallback(async () => {
    setListBusy(true)
    const res = await request({ op: 'list' })
    if (!alive.current) return
    setListBusy(false)
    const err = notesError(res)
    setListErr(err)
    if (!err) setNotes([...(res.reply?.notes ?? [])].sort((a, b) => b.updatedAt - a.updatedAt))
  }, [request])

  const loadNote = useCallback(
    async (id: string) => {
      setNoteBusy(true)
      const res = await request({ op: 'read', noteId: id })
      if (!alive.current) return
      setNoteBusy(false)
      const err = notesError(res)
      setNoteErr(err)
      const n = err ? null : (res.reply?.note ?? null)
      setNote(n)
      dirty.current = false
      setConflict(false)
      if (n) {
        setText(n.text ?? '')
        setOpen({ id, seq: ++docSeq.current, initial: n.text ?? '', rev: n.rev, partial: n.readOnly === true })
      } else setOpen(null)
    },
    [request],
  )

  const write = useCallback(
    async (force: boolean): Promise<void> => {
      const cur = openRef.current
      if (!cur || !dirty.current || cur.partial) return
      const body = textRef.current
      inFlight.current = true
      setSaving(true)
      const res = await request({ op: 'write', noteId: cur.id, text: body, ...(force ? {} : { baseRev: cur.rev }) })
      inFlight.current = false
      if (!alive.current) return
      setSaving(false)
      if (openRef.current?.id !== cur.id) return
      const reply = res.reply
      if (res.ok && reply?.ok && reply.note) {
        const meta = reply.note
        cur.rev = meta.rev
        if (textRef.current === body) dirty.current = false
        setConflict(false)
        setNotes((list) => [meta, ...(list ?? []).filter((n) => n.id !== meta.id)])
      } else if (res.ok && reply?.error === 'conflict') {
        setConflict(true)
      } else {
        const tooLarge = res.error === 'too_large' || reply?.error === 'too_large'
        toast.error(t(tooLarge ? 'shareGuest.notes.tooLarge' : 'wsnotes.saveFailed'), { dedupeKey: `share-notes-save:${linkId}` })
      }
      // A change announced meanwhile that was not this save's echo.
      const rev = deferred.current
      deferred.current = undefined
      if (rev === undefined || rev === cur.rev) return
      if (dirty.current) setConflict(true)
      else void loadNote(cur.id)
    },
    [request, linkId, t, loadNote],
  )

  /** Writes the pending text now, after any save in flight. `force`: overwrite the host's (Keep mine). */
  const save = useCallback(
    (force = false): Promise<void> => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const run = chain.current.then(() => write(force))
      chain.current = run.catch(() => undefined)
      return run
    },
    [write],
  )

  // A new session (or a resume): the list again, and the open note when it is clean.
  useEffect(() => {
    if (liveKey === null) return
    void loadList()
    const cur = openRef.current
    if (cur && !dirty.current) void loadNote(cur.id)
  }, [liveKey, loadList, loadNote])

  // Leaving the drawer writes what is pending.
  useEffect(() => () => void save(), [save])

  const lastSeq = useRef(seq?.n ?? 0)
  useEffect(() => {
    const n = seq?.n ?? 0
    if (n === lastSeq.current) return
    lastSeq.current = n
    void loadList()
    if (!openId || (seq?.noteId && seq.noteId !== openId)) return
    const cur = openRef.current
    if (inFlight.current) {
      deferred.current = seq?.rev ?? null
      return
    }
    // The echo of this guest's own save (v2 hosts send the rev).
    if (cur && seq?.rev && seq.rev === cur.rev) return
    if (cur && dirty.current) setConflict(true)
    else void loadNote(openId)
  }, [seq, openId, loadList, loadNote])

  const pick = async (id: string): Promise<void> => {
    if (id === openId) return
    await save()
    setOpenId(id)
    setNote(null)
    setOpen(null)
    void loadNote(id)
  }

  const onChange = (next: string): void => {
    setText(next)
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), NOTE_SAVE_DEBOUNCE_MS)
  }

  const create = async (): Promise<void> => {
    await save()
    const res = await request({ op: 'create', text: '' })
    if (!alive.current) return
    const id = res.ok && res.reply?.ok ? res.reply.note?.id : undefined
    if (!id) {
      toast.error(t('wsnotes.saveFailed'), { dedupeKey: `share-notes-save:${linkId}` })
      return
    }
    await loadList()
    setOpenId(id)
    void loadNote(id)
    if (mode === 'preview') setModeSaved('split')
  }

  const remove = async (): Promise<void> => {
    setConfirmDelete(false)
    const cur = openRef.current
    if (!cur) return
    if (timer.current) clearTimeout(timer.current)
    dirty.current = false
    const res = await request({ op: 'delete', noteId: cur.id })
    if (!alive.current) return
    if (!(res.ok && res.reply?.ok)) {
      toast.error(t('wsnotes.deleteFailed'), { dedupeKey: `share-notes-delete:${linkId}` })
      return
    }
    setOpenId(null)
    setNote(null)
    setOpen(null)
    setText('')
    void loadList()
  }

  const setModeSaved = (next: NoteMode): void => {
    setMode(next)
    saveNoteMode(next)
  }

  const editable = canWrite && !!open && !open.partial
  const now = Date.now()
  const current = openId ? notes?.find((n) => n.id === openId) : undefined
  const title = current?.title || note?.title || (openId ? t('wsnotes.untitled') : '')
  const iconBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent'
  const modeBtn = (m: NoteMode, label: string, Icon: typeof Eye) => (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={mode === m}
        onClick={() => setModeSaved(m)}
        className={cn('flex h-7 w-7 items-center justify-center rounded-btn transition-colors', mode === m ? 'bg-accent-violet/20 text-text-primary' : 'text-text-secondary hover:bg-card hover:text-text-primary')}
        data-notes-mode={m}
      >
        <Icon size={14} />
      </button>
    </Tooltip>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-shared-notes data-shared-notes-write={canWrite ? 'true' : 'false'}>
      <div className={cn('flex shrink-0 flex-col border-r border-border', canWrite ? 'w-52' : 'w-60')}>
        {canWrite && (
          <div className="flex items-center justify-end gap-1 border-b border-border p-1.5">
            <button
              type="button"
              onClick={() => void create()}
              disabled={liveKey === null}
              className="flex items-center gap-1.5 rounded-btn px-2 py-1 text-xs text-text-primary transition-colors hover:bg-card disabled:opacity-40"
              data-shared-notes-new
            >
              <FilePlus2 size={14} />
              {t('wsnotes.new')}
            </button>
          </div>
        )}
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
              onClick={() => void pick(n.id)}
              className={cn('flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-card', openId === n.id && 'bg-card')}
            >
              <span className="truncate text-xs text-text-primary">{n.title || t('wsnotes.untitled')}</span>
              <span className="text-[10px] text-text-secondary">{formatAgeShort(Math.max(0, now - n.updatedAt), lang)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shared-note-view={openId ?? ''}>
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
        ) : !note || !open ? (
          noteBusy ? (
            <div className="flex justify-center pt-6 text-text-secondary">
              <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-label={t('shareGuest.notes.loading')} />
            </div>
          ) : null
        ) : editable ? (
          <>
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
              <span className={cn('min-w-0 flex-1 truncate text-xs', title ? 'text-text-primary' : 'text-text-secondary')} data-note-title>
                {title}
              </span>
              <span className="mr-1 text-[10px] text-text-secondary" aria-live="polite" data-note-saved>
                {saving ? t('wsnotes.saving') : dirty.current ? t('wsnotes.unsaved') : t('wsnotes.saved')}
              </span>
              {modeBtn('edit', t('wsnotes.modeEdit'), PencilLine)}
              {modeBtn('split', t('wsnotes.modeSplit'), Columns2)}
              {modeBtn('preview', t('wsnotes.modePreview'), Eye)}
              <span className="mx-1 h-4 w-px bg-border" />
              <Tooltip label={t('wsnotes.delete')} side="bottom">
                <button type="button" aria-label={t('wsnotes.delete')} onClick={() => setConfirmDelete(true)} className={cn(iconBtn, 'hover:text-state-error')} data-note-delete>
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            </div>
            {conflict && (
              <div role="alert" data-note-conflict className="flex shrink-0 items-center gap-2 border-b border-border bg-state-action/10 px-3 py-1.5 text-xs text-text-primary">
                <span className="min-w-0 flex-1">{t('shareGuest.notes.conflict')}</span>
                <button type="button" onClick={() => void loadNote(open.id)} className="rounded-btn border border-border bg-card px-2 py-0.5 hover:border-accent-violet/40" data-note-reload>
                  {t('wsnotes.reload')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    dirty.current = true
                    void save(true)
                  }}
                  className="rounded-btn border border-border bg-card px-2 py-0.5 hover:border-accent-violet/40"
                  data-note-keep
                >
                  {t('wsnotes.keepMine')}
                </button>
              </div>
            )}
            <div className="flex min-h-0 flex-1">
              {mode !== 'preview' && (
                <div className={cn('min-h-0 min-w-0', mode === 'split' ? 'w-1/2 border-r border-border' : 'flex-1')}>
                  <CodeEditor
                    docKey={`${open.id}:${open.seq}`}
                    initialText={open.initial}
                    fileName="note.md"
                    gutters={false}
                    wrap
                    autoFocus
                    tokens={look.tokens}
                    light={look.light}
                    fontFamily={look.fontFamily}
                    fontSize={look.fontSize}
                    onChange={onChange}
                    onSave={() => void save()}
                  />
                </div>
              )}
              {mode !== 'edit' && (
                <div className={cn('min-h-0 min-w-0 overflow-y-auto px-5 py-3', mode === 'split' ? 'w-1/2' : 'flex-1')} data-note-preview>
                  {text.trim() ? <SharedMarkdown text={text} onLink={(href) => confirmLink(href, hostLabel)} /> : <p className="text-xs text-text-secondary">{t('wsnotes.previewEmpty')}</p>}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {note.readOnly && (
              <p data-shared-note-partial className="mb-3 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
                {t(canWrite ? 'shareGuest.notes.partialNoEdit' : 'shareGuest.notes.partial')}
              </p>
            )}
            <SharedMarkdown text={note.text ?? ''} onLink={(href) => confirmLink(href, hostLabel)} />
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t('wsnotes.deleteTitle')}
        message={t('shareGuest.notes.deleteBody', { title, host: hostLabel })}
        confirmLabel={t('wsnotes.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
