/**
 * The Notes drawer of a workspace (v2.2, E9): its `.md` notes on the left,
 * the selected one in the code editor (Markdown) on the right, with Edit /
 * Split / Preview. Notes save on their own 600 ms after the last keystroke,
 * carrying the version they loaded: when the file changed elsewhere (the
 * phone, another editor) with edits pending here, a banner offers Reload or
 * Keep mine (overwrite). "Insert path" types the note's path into the console
 * so an agent can read it. `snaos notes open` (app 2.3.0) asks for a note
 * through `useSidePanels.noteRequest`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, Eye, FileInput, FilePlus2, FolderOpen, NotebookPen, PencilLine, Search, Trash2 } from 'lucide-react'
import type { Workspace } from '@shared/types'
import type { WsNoteDoc, WsNoteMeta } from '@shared/ws-notes'
import { formatAgeShort } from '@shared/agents'
import { useLang, useT } from '@/i18n'
import { useSidePanels, closeSidePanel, clearNoteRequest, type NoteRequest } from '@/lib/sidePanels'
import { insertPathToConsole } from '@/lib/insertPath'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'
import { RightDrawer } from '@/components/ui/RightDrawer'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { MarkdownDoc } from '@/components/ui/MarkdownDoc'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { useEditorLook } from '@/components/editor/useEditorLook'

/** A note saves this long after the last keystroke. */
export const NOTE_SAVE_DEBOUNCE_MS = 600
type Mode = 'edit' | 'split' | 'preview'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
const lastKey = (wsId: string): string => `snagentsos.notes.${wsId}.last`
const MODE_KEY = 'snagentsos.notes.mode'

function loadMode(): Mode {
  try {
    const v = storage()?.getItem(MODE_KEY)
    return v === 'edit' || v === 'split' || v === 'preview' ? v : 'split'
  } catch {
    return 'split'
  }
}

interface Open {
  id: string
  /** Bumped on every (re)load: a new editor document. */
  seq: number
  initial: string
  rev: string
  path?: string
}

export default function NotesPanel({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const lang = useLang()
  const look = useEditorLook()
  const maximized = useSidePanels((s) => s.maximized)
  const wsId = workspace.id
  const [notes, setNotes] = useState<WsNoteMeta[]>([])
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Open | null>(null)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>(loadMode)
  const [conflict, setConflict] = useState<WsNoteDoc | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  // Refs for the async paths (debounced save, change events).
  const openRef = useRef<Open | null>(null)
  openRef.current = open
  const textRef = useRef(text)
  textRef.current = text
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  /** The first load finished: later note requests are taken by their own effect. */
  const ready = useRef(false)
  /** Bumped by every switch (a pick or a `snaos notes open`): an older switch still in flight drops its result. */
  const nav = useRef(0)
  const noteRequest = useSidePanels((s) => s.noteRequest)

  const refresh = useCallback(async (): Promise<WsNoteMeta[]> => {
    const res = await window.snApi.wsNotes.list(wsId).catch(() => null)
    const list = res?.ok ? res.notes : []
    setNotes(list)
    return list
  }, [wsId])

  const load = useCallback(
    async (noteId: string, stale?: () => boolean): Promise<void> => {
      const res = await window.snApi.wsNotes.read({ workspaceId: wsId, noteId }).catch(() => null)
      if (stale?.()) return
      if (!res?.ok) {
        if (res && res.error === 'too_large') toast.error(t('wsnotes.tooLarge'))
        return
      }
      dirty.current = false
      setConflict(null)
      setText(res.note.text)
      setOpen({ id: noteId, seq: ++seq.current, initial: res.note.text, rev: res.note.rev, path: res.note.path })
      try {
        storage()?.setItem(lastKey(wsId), noteId)
      } catch {
        /* blocked storage */
      }
    },
    [wsId, t],
  )

  /** Writes the pending text now. `force`: overwrite whatever is on disk (Keep mine). */
  const save = useCallback(
    async (force = false): Promise<void> => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const cur = openRef.current
      if (!cur || !dirty.current) return
      const body = textRef.current
      setSaving(true)
      const res = await window.snApi.wsNotes.write({ workspaceId: wsId, noteId: cur.id, text: body, ...(force ? {} : { baseRev: cur.rev }) }).catch(() => null)
      setSaving(false)
      if (openRef.current?.id !== cur.id) return
      if (res?.ok) {
        cur.rev = res.note.rev
        if (textRef.current === body) dirty.current = false
        setConflict(null)
        setNotes((list) => [res.note, ...list.filter((n) => n.id !== res.note.id)])
        return
      }
      if (res && res.error === 'conflict' && res.current) setConflict(res.current)
      else toast.error(t('wsnotes.saveFailed'), { dedupeKey: 'ws-notes-save' })
    },
    [wsId, t],
  )

  /**
   * A `snaos notes open` for this workspace: refresh (the note may be brand new), then show it. It never
   * switches away from edits that did not save (a conflict or a write error): the user resolves those first.
   * Only the latest switch applies.
   */
  const takeRequest = useCallback(
    async (req: NoteRequest): Promise<void> => {
      const mine = ++nav.current
      const stale = (): boolean => nav.current !== mine
      clearNoteRequest(req.seq)
      const list = await refresh()
      if (stale() || !list.some((n) => n.id === req.noteId) || openRef.current?.id === req.noteId) return
      await save()
      if (stale()) return
      if (dirty.current) {
        toast.info(t('wsnotes.openBlocked'), { dedupeKey: 'ws-notes-open-blocked' })
        return
      }
      await load(req.noteId, stale)
    },
    [refresh, save, load, t],
  )

  // First load: the list, then the note a `snaos notes open` asked for, else the last one opened here (or the newest).
  useEffect(() => {
    let alive = true
    ready.current = false
    void refresh().then(async (list) => {
      if (!alive) return
      const req = useSidePanels.getState().noteRequest
      let target: string | null = null
      if (req && req.workspaceId === wsId) {
        clearNoteRequest(req.seq)
        if (list.some((n) => n.id === req.noteId)) target = req.noteId
      }
      if (!target && list.length) {
        let last: string | null = null
        try {
          last = storage()?.getItem(lastKey(wsId)) ?? null
        } catch {
          last = null
        }
        target = list.some((n) => n.id === last) ? last! : list[0].id
      }
      if (target) await load(target)
      if (!alive) return
      ready.current = true
      // One that came in while the first note loaded.
      const late = useSidePanels.getState().noteRequest
      if (late && late.workspaceId === wsId) void takeRequest(late)
    })
    return () => {
      alive = false
    }
  }, [wsId, refresh, load, takeRequest])

  // Later asks while the drawer is open (the first load takes the one that opened it).
  useEffect(() => {
    if (!noteRequest || noteRequest.workspaceId !== wsId || !ready.current) return
    void takeRequest(noteRequest)
  }, [noteRequest, wsId, takeRequest])

  // Leaving the drawer (or the app) writes what is pending.
  useEffect(() => {
    const flush = (): void => void save()
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      void save()
    }
  }, [save])

  // A change made elsewhere: refresh the list; reload the open note when it is clean, else offer the choice.
  useEffect(
    () =>
      window.snApi.wsNotes.onChanged((evt) => {
        if (evt.workspaceId !== wsId) return
        void refresh()
        const cur = openRef.current
        if (!cur || evt.noteId !== cur.id || (evt.rev && evt.rev === cur.rev)) return
        void window.snApi.wsNotes.read({ workspaceId: wsId, noteId: cur.id }).then((res) => {
          if (openRef.current?.id !== cur.id) return
          if (!res.ok) {
            if (res.error === 'not_found') {
              setOpen(null)
              setText('')
            }
            return
          }
          if (res.note.rev === cur.rev) return
          if (dirty.current) setConflict(res.note)
          else void load(cur.id)
        })
      }),
    [wsId, refresh, load],
  )

  const onChange = (next: string): void => {
    setText(next)
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), NOTE_SAVE_DEBOUNCE_MS)
  }

  const pick = async (noteId: string): Promise<void> => {
    if (open?.id === noteId) return
    const mine = ++nav.current
    const stale = (): boolean => nav.current !== mine
    await save()
    if (stale()) return
    await load(noteId, stale)
  }

  const create = async (): Promise<void> => {
    await save()
    const res = await window.snApi.wsNotes.create({ workspaceId: wsId, text: '' }).catch(() => null)
    if (!res?.ok) {
      toast.error(t('wsnotes.saveFailed'))
      return
    }
    setFilter('')
    await refresh()
    await load(res.note.id)
    if (mode === 'preview') setModeSaved('split')
  }

  const remove = async (): Promise<void> => {
    setConfirmDelete(false)
    const cur = openRef.current
    if (!cur) return
    if (timer.current) clearTimeout(timer.current)
    dirty.current = false
    const res = await window.snApi.wsNotes.delete({ workspaceId: wsId, noteId: cur.id }).catch(() => null)
    if (!res?.ok) {
      toast.error(t('wsnotes.deleteFailed'))
      return
    }
    setOpen(null)
    setText('')
    const list = await refresh()
    if (list.length) await load(list[0].id)
  }

  const setModeSaved = (next: Mode): void => {
    setMode(next)
    try {
      storage()?.setItem(MODE_KEY, next)
    } catch {
      /* blocked storage */
    }
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? notes.filter((n) => (n.title || t('wsnotes.untitled')).toLowerCase().includes(q)) : notes
  }, [notes, filter, t])
  const now = Date.now()
  const current = open ? notes.find((n) => n.id === open.id) : undefined
  const title = current?.title || (open ? t('wsnotes.untitled') : '')

  const iconBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent'
  const modeBtn = (m: Mode, label: string, Icon: typeof Eye) => (
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
    <RightDrawer
      id="notes"
      title={t('wsnotes.title')}
      icon={<NotebookPen size={15} className="shrink-0 text-accent-violet" />}
      defaultWidth="clamp(540px, 46%, 980px)"
      maximized={maximized}
      onMaximize={(on) => useSidePanels.setState({ maximized: on })}
      onClose={closeSidePanel}
    >
      <div data-notes-panel={wsId} className="flex min-h-0 min-w-0 flex-1">
        <aside className="flex w-52 shrink-0 flex-col border-r border-border">
          <div className="flex items-center gap-1 p-2">
            <div className="relative min-w-0 flex-1">
              <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('wsnotes.filter')}
                aria-label={t('wsnotes.filter')}
                className="h-7 w-full rounded-btn border border-border bg-bg-secondary pl-6 pr-2 text-xs text-text-primary outline-none focus:border-accent-violet"
                data-notes-filter
              />
            </div>
            <Tooltip label={t('wsnotes.new')} side="bottom">
              <button type="button" aria-label={t('wsnotes.new')} onClick={() => void create()} className={iconBtn} data-notes-new>
                <FilePlus2 size={15} />
              </button>
            </Tooltip>
          </div>
          <div role="listbox" aria-label={t('wsnotes.title')} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {shown.length === 0 ? (
              <p className="px-2 py-4 text-center text-[11px] text-text-secondary">{notes.length ? t('wsnotes.noMatch') : t('wsnotes.empty')}</p>
            ) : (
              shown.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  role="option"
                  aria-selected={open?.id === n.id}
                  onClick={() => void pick(n.id)}
                  className={cn(
                    'flex w-full flex-col items-start rounded-btn px-2 py-1.5 text-left transition-colors',
                    open?.id === n.id ? 'bg-accent-violet/15 text-text-primary' : 'text-text-primary/90 hover:bg-bg-secondary',
                  )}
                  data-note-row={n.id}
                >
                  <span className={cn('w-full truncate text-[13px]', !n.title && 'italic text-text-secondary')}>{n.title || t('wsnotes.untitled')}</span>
                  <span className="text-[10px] text-text-secondary">{formatAgeShort(Math.max(0, now - n.updatedAt), lang)}</span>
                </button>
              ))
            )}
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          {open ? (
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
                <Tooltip label={t('wsnotes.insertPath')} side="bottom">
                  <button
                    type="button"
                    aria-label={t('wsnotes.insertPath')}
                    disabled={!open.path}
                    onClick={() => {
                      void save().then(() => {
                        if (open.path && !insertPathToConsole(open.path)) toast.error(t('wsnotes.insertFailed'))
                      })
                    }}
                    className={iconBtn}
                    data-note-insert
                  >
                    <FileInput size={14} />
                  </button>
                </Tooltip>
                <Tooltip label={t('wsnotes.openOutside')} side="bottom">
                  <button type="button" aria-label={t('wsnotes.openOutside')} onClick={() => void save().then(() => window.snApi.wsNotes.open({ workspaceId: wsId, noteId: open.id }))} className={iconBtn}>
                    <FolderOpen size={14} />
                  </button>
                </Tooltip>
                <Tooltip label={t('wsnotes.delete')} side="bottom">
                  <button type="button" aria-label={t('wsnotes.delete')} onClick={() => setConfirmDelete(true)} className={cn(iconBtn, 'hover:text-state-error')} data-note-delete>
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </div>
              {conflict && (
                <div role="alert" data-note-conflict className="flex shrink-0 items-center gap-2 border-b border-border bg-state-action/10 px-3 py-1.5 text-xs text-text-primary">
                  <span className="min-w-0 flex-1">{t('wsnotes.conflict')}</span>
                  <button type="button" onClick={() => void load(open.id)} className="rounded-btn border border-border bg-card px-2 py-0.5 hover:border-accent-violet/40" data-note-reload>
                    {t('wsnotes.reload')}
                  </button>
                  <button type="button" onClick={() => void save(true)} className="rounded-btn border border-border bg-card px-2 py-0.5 hover:border-accent-violet/40" data-note-keep>
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
                    {text.trim() ? <MarkdownDoc text={text} /> : <p className="text-xs text-text-secondary">{t('wsnotes.previewEmpty')}</p>}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <NotebookPen size={28} className="text-text-secondary/60" />
              <p className="max-w-xs text-xs text-text-secondary">{t('wsnotes.intro')}</p>
              <button type="button" onClick={() => void create()} className="flex items-center gap-1.5 rounded-btn bg-accent-violet px-3 py-1.5 text-xs font-medium text-white" data-notes-first>
                <FilePlus2 size={14} />
                {t('wsnotes.new')}
              </button>
            </div>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t('wsnotes.deleteTitle')}
        message={t('wsnotes.deleteBody', { title })}
        confirmLabel={t('wsnotes.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </RightDrawer>
  )
}
