/**
 * Notes of a workspace on the phone (v2.2, E9), a pushed screen opened from
 * the workspace's menu on Home. The list (newest first) and a note rendered
 * as Markdown; Edit turns it into a text field with dictation and an
 * explicit Save that carries the version it loaded: when the PC changed the
 * note meanwhile, the phone offers Reload or Save anyway. A note too long for
 * one message (WS_NOTE_PHONE_MAX) is read-only here. Everything lives on the
 * PC (notesReq); a request without an answer shows "The PC did not answer".
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight, FilePlus2, Loader2, NotebookPen, PencilLine, Trash2 } from 'lucide-react'
import type { RemoteNote } from '@shared/remote-protocol'
import type { WsNoteMeta } from '@shared/ws-notes'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { ConfirmSheet, type ConfirmState } from '../ConfirmSheet'
import { Markdown } from '../chat/Markdown'
import { MicButton, VoiceInterim } from '../MicButton'
import { client } from '../../lib/client'
import { isNoReply } from '../../lib/pending'
import { useRemoteStore } from '../../lib/store'
import { useBackClaim } from '../../lib/useBackClaim'
import { closeWsNotes, fitsPhone, openNote, useWsNotes } from '../../lib/wsNotes'
import { relativeAge } from '../../lib/statusText'
import { spaced, stopDictation } from '../../lib/voice'
import { t } from '../../lib/i18n'

type Load<T> = { status: 'loading' | 'ok' | 'noReply' | 'gone'; value: T | null }

export function WsNotesScreen(): ReactNode {
  const workspaceId = useWsNotes((s) => s.workspaceId)
  const noteId = useWsNotes((s) => s.noteId)
  const wsName = useRemoteStore((s) => s.snapshot?.workspaces.find((w) => w.id === workspaceId)?.name ?? '')
  const open = workspaceId != null
  return (
    <PushScreen open={open} onClose={closeWsNotes} title={wsName ? `${t('wsnotes.title')} - ${wsName}` : t('wsnotes.title')} id="ws-notes">
      {workspaceId && (noteId ? <NoteView key={noteId} workspaceId={workspaceId} noteId={noteId} /> : <NoteList workspaceId={workspaceId} />)}
    </PushScreen>
  )
}

function NoteList({ workspaceId }: { workspaceId: string }): ReactNode {
  const changed = useWsNotes((s) => s.changed)
  const [list, setList] = useState<Load<WsNoteMeta[]>>({ status: 'loading', value: null })
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const res = await client.requestNotes({ workspaceId, op: 'list' })
    if (!res.ok) setList((cur) => ({ status: isNoReply(res.error) ? 'noReply' : 'loading', value: cur.value }))
    else setList({ status: res.value.ok ? 'ok' : 'gone', value: res.value.notes ?? [] })
  }, [workspaceId])

  useEffect(() => {
    void load()
  }, [load, changed])

  const create = async (): Promise<void> => {
    setCreating(true)
    const res = await client.requestNotes({ workspaceId, op: 'create', text: '' })
    setCreating(false)
    if (res.ok && res.value.ok && res.value.note) openNote(res.value.note.id)
    else useRemoteStore.getState().setToast(t('wsnotes.saveFailed'))
  }

  const now = Date.now()
  return (
    <div data-ws-notes-list className="flex flex-col gap-2 pb-6">
      <button
        type="button"
        onClick={() => void create()}
        disabled={creating}
        className="flex h-12 items-center justify-center gap-2 rounded-btn bg-accent-violet px-4 text-sm font-medium text-white disabled:opacity-50"
        data-ws-notes-new
      >
        {creating ? <Loader2 size={16} className="spin" /> : <FilePlus2 size={16} />}
        {t('wsnotes.new')}
      </button>
      {list.status === 'noReply' && <NoReply onRetry={() => void load()} />}
      {list.status === 'loading' && !list.value && (
        <div className="flex justify-center py-6">
          <Loader2 size={20} className="spin text-text-secondary" />
        </div>
      )}
      {list.value && list.value.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <NotebookPen size={26} className="text-text-secondary/60" />
          <p className="text-sm text-text-secondary">{t('wsnotes.empty')}</p>
          <p className="text-xs text-text-secondary/80">{t('wsnotes.intro')}</p>
        </div>
      )}
      {list.value?.map((n) => (
        <button
          key={n.id}
          type="button"
          onClick={() => openNote(n.id)}
          className="flex min-h-14 items-center gap-3 rounded-card border border-border bg-bg-secondary px-4 py-2 text-left active:bg-card"
          data-ws-note-row={n.id}
        >
          <span className="min-w-0 flex-1">
            <span className={clsx('block truncate text-sm', n.title ? 'text-text-primary' : 'italic text-text-secondary')}>{n.title || t('wsnotes.untitled')}</span>
            <span className="block text-[11px] text-text-secondary">{relativeAge(n.updatedAt, now)}</span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-text-secondary" />
        </button>
      ))}
    </div>
  )
}

function NoteView({ workspaceId, noteId }: { workspaceId: string; noteId: string }): ReactNode {
  const changed = useWsNotes((s) => s.changed)
  const changedNote = useWsNotes((s) => s.changedNote)
  const [note, setNote] = useState<Load<RemoteNote>>({ status: 'loading', value: null })
  const [draft, setDraft] = useState<string | null>(null)
  const [conflict, setConflict] = useState<RemoteNote | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // The note is a step inside the screen: back returns to the list.
  useBackClaim(true, () => openNote(null))

  const load = useCallback(async (): Promise<void> => {
    const res = await client.requestNotes({ workspaceId, op: 'read', noteId })
    if (!res.ok) {
      setNote((cur) => ({ status: isNoReply(res.error) ? 'noReply' : 'loading', value: cur.value }))
      return
    }
    if (!res.value.ok || !res.value.note) {
      setNote({ status: 'gone', value: null })
      return
    }
    setNote({ status: 'ok', value: res.value.note })
  }, [workspaceId, noteId])

  useEffect(() => {
    void load()
  }, [load])

  // A change on the PC: reload while reading; while editing, the save will tell.
  useEffect(() => {
    if (!changed || (changedNote && changedNote !== noteId)) return
    if (draftRef.current === null) void load()
  }, [changed, changedNote, noteId, load])

  const save = async (force = false): Promise<void> => {
    const text = draftRef.current
    const cur = note.value
    if (text === null || !cur) return
    if (!fitsPhone(text)) {
      useRemoteStore.getState().setToast(t('wsnotes.phoneTooLong'))
      return
    }
    stopDictation('wsNote', true)
    setSaving(true)
    const res = await client.requestNotes({ workspaceId, op: 'write', noteId, text, ...(force ? {} : { baseRev: cur.rev }) })
    setSaving(false)
    if (!res.ok) {
      useRemoteStore.getState().setToast(t('pending.noReply'))
      return
    }
    if (res.value.ok && res.value.note) {
      setNote({ status: 'ok', value: { ...res.value.note, text } })
      setDraft(null)
      setConflict(null)
      return
    }
    if (res.value.error === 'conflict' && res.value.current) setConflict(res.value.current)
    else useRemoteStore.getState().setToast(t('wsnotes.saveFailed'))
  }

  const remove = (): void =>
    setConfirm({
      message: t('wsnotes.deleteBody', { title: note.value?.title || t('wsnotes.untitled') }),
      onConfirm: () => {
        void client.requestNotes({ workspaceId, op: 'delete', noteId }).then((res) => {
          if (res.ok && res.value.ok) openNote(null)
          else useRemoteStore.getState().setToast(t('wsnotes.deleteFailed'))
        })
      },
    })

  if (note.status === 'noReply' && !note.value) return <NoReply onRetry={() => void load()} />
  if (note.status === 'gone') return <p className="py-8 text-center text-sm text-text-secondary">{t('wsnotes.gone')}</p>
  if (!note.value)
    return (
      <div className="flex justify-center py-8">
        <Loader2 size={20} className="spin text-text-secondary" />
      </div>
    )
  const n = note.value
  const editing = draft !== null
  const btn = 'flex h-11 items-center justify-center gap-1.5 rounded-btn px-4 text-sm font-medium'

  return (
    <div data-ws-note={noteId} className="flex flex-col gap-3 pb-6">
      <button type="button" onClick={() => openNote(null)} className="-ml-1 flex h-9 items-center gap-1 self-start rounded-btn px-1 text-sm text-text-secondary active:bg-card" data-ws-notes-all>
        <ChevronLeft size={16} />
        {t('wsnotes.all')}
      </button>
      {n.readOnly && <p className="rounded-btn border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary" data-ws-note-readonly>{t('wsnotes.phoneReadOnly')}</p>}
      {conflict && (
        <div role="alert" className="flex flex-col gap-2 rounded-btn border border-state-action/50 bg-state-action/10 px-3 py-2 text-xs text-text-primary" data-ws-note-conflict>
          <span>{t('wsnotes.conflict')}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(null)
                setConflict(null)
                setNote({ status: 'ok', value: conflict })
              }}
              className="h-9 flex-1 rounded-btn border border-border bg-card px-3"
            >
              {t('wsnotes.reload')}
            </button>
            <button type="button" onClick={() => void save(true)} className="h-9 flex-1 rounded-btn border border-border bg-card px-3" data-ws-note-force>
              {t('wsnotes.saveAnyway')}
            </button>
          </div>
        </div>
      )}
      {editing ? (
        <>
          <VoiceInterim owner="wsNote" />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            autoFocus
            aria-label={t('wsnotes.title')}
            className="min-h-[50vh] w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 font-mono text-[15px] leading-6 text-text-primary outline-none focus:border-accent-violet"
            data-ws-note-text
          />
          <div className="flex gap-2">
            <MicButton owner="wsNote" resetKey={noteId} onFinal={(chunk) => setDraft((prev) => (prev ?? '') + spaced(prev ?? '', chunk))} />
            <button type="button" onClick={() => setDraft(null)} className={clsx(btn, 'flex-1 border border-border text-text-secondary')}>
              {t('act.cancel')}
            </button>
            <button type="button" disabled={saving} onClick={() => void save()} className={clsx(btn, 'flex-1 bg-accent-violet text-white disabled:opacity-50')} data-ws-note-save>
              {saving ? <Loader2 size={16} className="spin" /> : null}
              {t('wsnotes.save')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="min-h-24 rounded-card border border-border bg-bg-secondary px-4 py-3" data-ws-note-view>
            {n.text?.trim() ? <Markdown text={n.text} /> : <p className="text-sm italic text-text-secondary">{t('wsnotes.emptyNote')}</p>}
          </div>
          <div className="flex gap-2">
            {!n.readOnly && (
              <button type="button" onClick={() => setDraft(n.text ?? '')} className={clsx(btn, 'flex-1 bg-accent-violet text-white')} data-ws-note-edit>
                <PencilLine size={16} />
                {t('wsnotes.edit')}
              </button>
            )}
            <button type="button" onClick={remove} aria-label={t('wsnotes.delete')} className={clsx(btn, 'border border-border text-state-error')} data-ws-note-delete>
              <Trash2 size={16} />
            </button>
          </div>
        </>
      )}
      <ConfirmSheet state={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
