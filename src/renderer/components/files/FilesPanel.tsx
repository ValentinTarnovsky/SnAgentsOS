/**
 * The Files drawer of a workspace (v2.2, E9): its folder as a tree on the
 * left and the open files in tabs with the code editor, VS Code style. Ctrl+S
 * saves; a dot marks unsaved tabs. When an agent changes an open file, a
 * clean tab reloads on its own and one with edits shows Reload / Keep mine.
 * Markdown files have a preview, images show as images. The tree's context
 * menu creates, renames (F2), deletes to the OS trash, copies the path,
 * inserts it into the console, reveals it in the file manager or opens it
 * outside (inert formats only). Main owns the disk: ids and relative paths go
 * out, never an absolute path. A Ctrl+click on `file:line` in a terminal
 * (app 2.7.0, A9) opens the file here at that line, in the tree of the
 * console's worktree when it has one.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  ChevronsDownUp,
  Copy,
  ExternalLink,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  PencilLine,
  RefreshCw,
  Search,
  TextCursorInput,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { Workspace } from '@shared/types'
import { baseName, isSafeName, joinRel, parentRel, type FilesError } from '@shared/files'
import { useT } from '@/i18n'
import { useSidePanels, closeSidePanel, setSidePanelMaximized } from '@/lib/sidePanels'
import {
  absPath,
  applyFilesChanged,
  changedKey,
  clearReveal,
  closeTab,
  collapseAll,
  filesIds,
  isDirty,
  loadDir,
  openFile,
  reloadTab,
  reloadTree,
  renameTabs,
  restoreUnsaved,
  saveTab,
  setActiveTab,
  setTabText,
  showFilesTree,
  shownFilesKey,
  stashUnsaved,
  toggleDir,
  useFilesStore,
  wsFiles,
} from '@/lib/filesStore'
import { useAppStore } from '@/lib/store'
import { insertPathToConsole } from '@/lib/insertPath'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'
import { RightDrawer } from '@/components/ui/RightDrawer'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ContextMenu } from '@/components/ui/ContextMenu'
import { MarkdownDoc } from '@/components/ui/MarkdownDoc'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { isMarkdownName, languageLabel } from '@/components/editor/languages'
import { useEditorLook } from '@/components/editor/useEditorLook'
import { FILES_ERROR_KEY as ERROR_KEY, FileIcon, TabButton, TreeItem, flatten } from './fileTreeParts'

// Unsaved buffers survive a quit or a reload (hot exit).
window.addEventListener('beforeunload', stashUnsaved)

type Menu = { x: number; y: number; rel: string; kind: 'file' | 'dir' }
type Draft = { mode: 'newFile' | 'newDir' | 'rename'; dir: string; rel?: string; value: string }

/** A shown tree still names something: its workspace, or a console that has a worktree. */
function treeAlive(workspaces: readonly Workspace[], key: string): boolean {
  const { workspaceId, paneId } = filesIds(key)
  if (!paneId) return workspaces.some((w) => w.id === workspaceId)
  return workspaces.some((w) => w.panes.some((p) => p.id === paneId && !!p.worktree))
}

/**
 * The drawer shows the workspace's tree, or the one a Ctrl+click on a
 * terminal path switched it to (a worktree console's, `wsId#paneId`, app
 * 2.7.0, A9); a switch starts that tree's view afresh.
 */
export default function FilesPanel({ workspace }: { workspace: Workspace }) {
  const shown = useFilesStore((s) => shownFilesKey(s, workspace.id))
  const alive = useAppStore((s) => treeAlive(s.workspaces, shown))
  const tree = alive ? shown : workspace.id
  return <FilesTree key={tree} workspace={workspace} tree={tree} />
}

function FilesTree({ workspace, tree }: { workspace: Workspace; tree: string }) {
  const t = useT()
  const look = useEditorLook()
  // What this tree names to main: its workspace, and the console of a worktree tree.
  const ids = filesIds(tree)
  const maximized = useSidePanels((s) => !!s.maximized[workspace.id])
  const ws = useFilesStore((s) => wsFiles(s, tree))
  const [root, setRoot] = useState<{ root: string; name: string } | null>(null)
  const [rootError, setRootError] = useState<FilesError | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [trash, setTrash] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [preview, setPreview] = useState(false)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const platform = window.snApi.platform

  // The folder, its first level, the stash of a previous run, and the watch while the drawer shows.
  useEffect(() => {
    let alive = true
    void window.snApi.files.root(ids.workspaceId, ids.paneId).then((res) => {
      if (!alive) return
      if (!res.ok) {
        setRootError(res.error)
        return
      }
      setRoot({ root: res.root, name: res.name })
      setRootError(null)
      void reloadTree(tree)
      restoreUnsaved(tree)
    })
    window.snApi.files.watch(ids.workspaceId, ids.paneId)
    const off = window.snApi.files.onChanged((evt) => {
      if (changedKey(evt) === tree) void applyFilesChanged(evt)
    })
    return () => {
      alive = false
      off()
      window.snApi.files.watch(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree])

  const rows = useMemo(() => flatten(ws.dirs, ws.expanded, filter), [ws.dirs, ws.expanded, filter])
  const active = ws.tabs.find((tab) => tab.rel === ws.active) ?? null
  const isMd = !!active && active.kind === 'text' && isMarkdownName(active.rel)
  // A Ctrl+click on `file:line` lands in the editor, not in a Markdown preview.
  const revealing = active?.reveal?.seq
  useEffect(() => {
    if (revealing !== undefined) setPreview(false)
  }, [revealing])

  const fail = useCallback((err: FilesError | null): boolean => {
    if (!err) return false
    toast.error(t(ERROR_KEY[err]), { dedupeKey: 'files-op' })
    return true
  }, [t])

  const open = async (rel: string): Promise<void> => {
    setSelected(rel)
    fail(await openFile(tree, rel))
  }

  const save = async (rel: string, force = false): Promise<void> => {
    const err = await saveTab(tree, rel, force)
    if (err === 'conflict') return
    fail(err)
  }

  const absOf = (rel: string): string | null => (root ? absPath(root.root, rel, platform) : null)

  const submitDraft = async (): Promise<void> => {
    const d = draft
    setDraft(null)
    if (!d) return
    const name = d.value.trim()
    if (!name || (d.mode === 'rename' && name === baseName(d.rel ?? ''))) return
    if (!isSafeName(name)) {
      fail('invalid')
      return
    }
    const target = joinRel(d.dir, name)
    if (d.mode === 'rename' && d.rel) {
      const res = await window.snApi.files.rename({ ...ids, from: d.rel, to: target })
      if (!res.ok) return void fail(res.error)
      renameTabs(tree, d.rel, target)
      setSelected(target)
    } else {
      const res = await window.snApi.files.create({ ...ids, rel: target, kind: d.mode === 'newDir' ? 'dir' : 'file' })
      if (!res.ok) return void fail(res.error)
      if (d.mode === 'newFile') void open(target)
    }
    await loadDir(tree, d.dir)
  }

  const startDraft = (mode: Draft['mode'], rel?: string): void => {
    setMenu(null)
    const sel = rel ?? selected ?? ''
    const selKind = rows.find((r) => r.rel === sel)?.kind
    if (mode === 'rename') {
      if (!sel) return
      setDraft({ mode, dir: parentRel(sel), rel: sel, value: baseName(sel) })
      return
    }
    const dir = sel && selKind === 'dir' ? sel : parentRel(sel)
    if (dir && !ws.expanded.includes(dir)) toggleDir(tree, dir)
    setDraft({ mode, dir, value: '' })
  }

  const doTrash = async (): Promise<void> => {
    const rel = trash
    setTrash(null)
    if (!rel) return
    const res = await window.snApi.files.trash({ ...ids, rel })
    if (!res.ok) return void fail(res.error)
    for (const tab of ws.tabs) if (tab.rel === rel || tab.rel.startsWith(`${rel}/`)) closeTab(tree, tab.rel)
    await loadDir(tree, parentRel(rel))
  }

  const onTreeKey = (e: ReactKeyboardEvent): void => {
    if (!selected || draft) return
    if (e.key === 'F2') {
      e.preventDefault()
      startDraft('rename', selected)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      setTrash(selected)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows.find((r) => r.rel === selected)
      if (row?.kind === 'dir') toggleDir(tree, row.rel)
      else if (row) void open(row.rel)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = rows.findIndex((r) => r.rel === selected)
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) setSelected(next.rel)
    }
  }

  // Back to the first level: also clears the filter, which shows every loaded match open.
  // The button turns disabled under the focus, so the tree takes the keyboard (Esc, arrows).
  const collapse = (): void => {
    collapseAll(tree)
    setFilter('')
    if (selected?.includes('/')) setSelected(null)
    if (treeRef.current) {
      treeRef.current.scrollTop = 0
      treeRef.current.focus({ preventScroll: true })
    }
  }
  const collapsed = ws.expanded.length <= 1 && !filter.trim()

  const iconBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary'
  const headerActions = (
    <>
      {tree !== workspace.id && (
        <Tooltip label={t('files.backToWorkspace')} side="bottom">
          <button type="button" aria-label={t('files.backToWorkspace')} onClick={() => showFilesTree(workspace.id, workspace.id)} className={iconBtn} data-files-back>
            <Undo2 size={14} />
          </button>
        </Tooltip>
      )}
      <Tooltip label={t('files.newFile')} side="bottom">
        <button type="button" aria-label={t('files.newFile')} onClick={() => startDraft('newFile')} className={iconBtn} data-files-new-file>
          <FilePlus2 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('files.newFolder')} side="bottom">
        <button type="button" aria-label={t('files.newFolder')} onClick={() => startDraft('newDir')} className={iconBtn}>
          <FolderPlus size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('files.refresh')} side="bottom">
        <button type="button" aria-label={t('files.refresh')} onClick={() => void reloadTree(tree)} className={iconBtn} data-files-refresh>
          <RefreshCw size={13} />
        </button>
      </Tooltip>
      <Tooltip label={t('files.collapse')} side="bottom">
        <button type="button" aria-label={t('files.collapse')} onClick={collapse} disabled={collapsed} className={iconBtn} data-files-collapse>
          <ChevronsDownUp size={14} />
        </button>
      </Tooltip>
      <span className="mx-1 h-4 w-px bg-border" />
    </>
  )

  const draftInput = (d: Draft, depth: number): ReactNode => (
    <div className="flex items-center gap-1 py-0.5 pr-2" style={{ paddingLeft: 8 + depth * 12 }}>
      {d.mode === 'newDir' ? <Folder size={14} className="shrink-0 text-text-secondary" /> : <FileIcon name={d.value || 'x'} />}
      <input
        autoFocus
        value={d.value}
        onChange={(e) => setDraft({ ...d, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void submitDraft()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(null)
          }
        }}
        onBlur={() => void submitDraft()}
        aria-label={d.mode === 'rename' ? t('files.rename') : d.mode === 'newDir' ? t('files.newFolder') : t('files.newFile')}
        className="h-6 min-w-0 flex-1 rounded border border-accent-violet bg-bg-primary px-1.5 text-xs text-text-primary outline-none"
        data-files-draft={d.mode}
      />
    </div>
  )

  return (
    <RightDrawer
      id="files"
      pinScope={workspace.id}
      title={root ? `${t('files.title')} - ${root.name}` : t('files.title')}
      icon={<FolderTree size={15} className="shrink-0 text-accent-violet" />}
      actions={headerActions}
      defaultWidth="clamp(640px, 62%, 1400px)"
      maximized={maximized}
      onMaximize={(on) => setSidePanelMaximized(workspace.id, on)}
      onClose={closeSidePanel}
    >
      <div data-files-panel={workspace.id} data-files-tree-key={tree} className="flex min-h-0 min-w-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border" onKeyDown={onTreeKey}>
          <div className="p-2">
            <div className="relative">
              <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('files.filter')}
                aria-label={t('files.filter')}
                className="h-7 w-full rounded-btn border border-border bg-bg-secondary pl-6 pr-2 text-xs text-text-primary outline-none focus:border-accent-violet"
                data-files-filter
              />
            </div>
          </div>
          <div ref={treeRef} role="tree" aria-label={t('files.title')} tabIndex={0} className="min-h-0 flex-1 overflow-auto pb-2 outline-none" data-files-tree>
            {rootError ? (
              <p className="px-3 py-4 text-center text-[11px] text-text-secondary" data-files-root-error={rootError}>
                {t(rootError === 'no_root' ? 'files.noFolder' : ERROR_KEY[rootError])}
              </p>
            ) : (
              <>
                {draft && draft.dir === '' && draft.mode !== 'rename' && draftInput(draft, 0)}
                {rows.map((r) => (
                  <div key={r.rel}>
                    {draft?.mode === 'rename' && draft.rel === r.rel ? (
                      draftInput(draft, r.depth)
                    ) : (
                      <TreeItem
                        row={r}
                        selected={selected === r.rel}
                        current={ws.active === r.rel}
                        onClick={() => {
                          setSelected(r.rel)
                          if (r.kind === 'dir') toggleDir(tree, r.rel)
                          else void open(r.rel)
                        }}
                        onContextMenu={(e: ReactMouseEvent) => {
                          e.preventDefault()
                          setSelected(r.rel)
                          setMenu({ x: e.clientX, y: e.clientY, rel: r.rel, kind: r.kind })
                        }}
                      />
                    )}
                    {draft && draft.mode !== 'rename' && r.kind === 'dir' && r.open && draft.dir === r.rel && draftInput(draft, r.depth + 1)}
                  </div>
                ))}
                {ws.dirs['']?.truncated && <p className="px-3 py-1 text-[10px] text-text-secondary">{t('files.truncated')}</p>}
              </>
            )}
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          {ws.tabs.length > 0 && (
            <div role="tablist" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-bg-secondary/60" data-files-tabs>
              {ws.tabs.map((tab) => (
                <TabButton
                  key={tab.rel}
                  tab={tab}
                  active={tab.rel === ws.active}
                  onPick={() => setActiveTab(tree, tab.rel)}
                  onClose={() => (isDirty(tab) ? setClosing(tab.rel) : closeTab(tree, tab.rel))}
                  closeLabel={t('files.closeTab')}
                />
              ))}
            </div>
          )}
          {active ? (
            <>
              {active.external && (
                <div role="alert" data-file-external={active.external} className="flex shrink-0 items-center gap-2 border-b border-border bg-state-action/10 px-3 py-1.5 text-xs text-text-primary">
                  <span className="min-w-0 flex-1">{t(active.external === 'deleted' ? 'files.deletedOnDisk' : 'files.changedOnDisk')}</span>
                  {active.external !== 'deleted' && (
                    <button type="button" onClick={() => void reloadTab(tree, active.rel)} className="rounded-btn border border-border bg-card px-2 py-0.5 hover:border-accent-violet/40" data-file-reload>
                      {t('files.reload')}
                    </button>
                  )}
                  <button type="button" onClick={() => void save(active.rel, true)} className="rounded-btn border border-border bg-card px-2 py-0.5 hover:border-accent-violet/40" data-file-keep>
                    {t('files.keepMine')}
                  </button>
                </div>
              )}
              {active.restored && !active.external && (
                <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-violet/10 px-3 py-1.5 text-xs text-text-primary" data-file-restored>
                  <span className="min-w-0 flex-1">{t('files.restored')}</span>
                  <button type="button" onClick={() => void reloadTab(tree, active.rel)} className="rounded-btn border border-border bg-card px-2 py-0.5 hover:border-accent-violet/40">
                    {t('files.discard')}
                  </button>
                </div>
              )}
              <div className="relative min-h-0 flex-1">
                {active.kind === 'image' ? (
                  <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--color-bg-secondary)_0_25%,var(--color-bg-primary)_0_50%)] bg-[length:16px_16px] p-4" data-file-image>
                    <img src={active.dataUrl} alt={baseName(active.rel)} className="max-h-full max-w-full object-contain" />
                  </div>
                ) : preview && isMd ? (
                  <div className="h-full overflow-y-auto px-6 py-4" data-file-preview>
                    <MarkdownDoc text={active.text} />
                  </div>
                ) : (
                  ws.tabs
                    .filter((tab) => tab.kind === 'text')
                    .map((tab) => (
                      <div key={`${tab.rel}:${tab.seq}`} className={cn('absolute inset-0', tab.rel !== ws.active && 'hidden')}>
                        {/* The buffer, not the disk text: an editor mounted again (the drawer
                            reopened, the tree switched, the preview left) keeps the edits. */}
                        <CodeEditor
                          docKey={`${tab.rel}:${tab.seq}`}
                          initialText={tab.text}
                          fileName={baseName(tab.rel)}
                          readOnly={tab.readOnly}
                          tokens={look.tokens}
                          light={look.light}
                          fontFamily={look.fontFamily}
                          fontSize={look.fontSize}
                          autoFocus={tab.rel === ws.active}
                          onChange={(text) => setTabText(tree, tab.rel, text)}
                          onSave={() => void save(tab.rel)}
                          onCursor={(line, col) => {
                            if (tab.rel === useFilesStore.getState().byWs[tree]?.active) setCursor({ line, col })
                          }}
                          reveal={tab.rel === ws.active ? tab.reveal : undefined}
                          onRevealed={(seq) => clearReveal(tree, tab.rel, seq)}
                        />
                      </div>
                    ))
                )}
              </div>
              <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-text-secondary" data-files-status>
                <span className="min-w-0 flex-1 truncate">{active.rel}</span>
                {active.kind === 'text' && (
                  <>
                    {active.readOnly && <span className="text-state-action">{t('files.readOnly')}</span>}
                    <span>{t('files.cursor', { line: cursor.line, col: cursor.col })}</span>
                    <span>{languageLabel(baseName(active.rel), t('files.plainText'))}</span>
                    <span>{active.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
                    <span>{active.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
                  </>
                )}
                {isMd && (
                  <button type="button" onClick={() => setPreview((v) => !v)} className="flex items-center gap-1 hover:text-text-primary" data-file-preview-toggle>
                    {preview ? <PencilLine size={11} /> : <Eye size={11} />}
                    {preview ? t('files.edit') : t('files.preview')}
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <FolderTree size={28} className="text-text-secondary/60" />
              <p className="max-w-xs text-xs text-text-secondary">{t('files.intro')}</p>
            </div>
          )}
        </section>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('files.title')}
          onClose={() => setMenu(null)}
          items={[
            ...(menu.kind === 'file' ? [{ label: t('files.open'), icon: FileText, onClick: () => void open(menu.rel) }] : []),
            { label: t('files.newFile'), icon: FilePlus2, onClick: () => startDraft('newFile', menu.rel) },
            { label: t('files.newFolder'), icon: FolderPlus, onClick: () => startDraft('newDir', menu.rel) },
            { label: t('files.rename'), icon: PencilLine, onClick: () => startDraft('rename', menu.rel) },
            {
              label: t('files.insertPath'),
              icon: TextCursorInput,
              separated: true,
              onClick: () => {
                const p = absOf(menu.rel)
                if (!p || !insertPathToConsole(p)) toast.error(t('files.insertFailed'))
              },
            },
            {
              label: t('files.copyPath'),
              icon: Copy,
              onClick: () => {
                const p = absOf(menu.rel)
                if (p) window.snApi.clipboard.writeText(p)
              },
            },
            { label: t('files.copyRelPath'), icon: Copy, onClick: () => window.snApi.clipboard.writeText(menu.rel) },
            { label: t('files.reveal'), icon: FolderOpen, onClick: () => void window.snApi.files.reveal({ ...ids, rel: menu.rel }) },
            ...(menu.kind === 'file' ? [{ label: t('files.openOutside'), icon: ExternalLink, onClick: () => void window.snApi.files.open({ ...ids, rel: menu.rel }) }] : []),
            { label: t('files.trash'), icon: Trash2, danger: true, separated: true, onClick: () => setTrash(menu.rel) },
          ]}
        />
      )}
      <ConfirmDialog
        open={trash !== null}
        title={t('files.trashTitle')}
        message={t('files.trashBody', { name: trash ? baseName(trash) : '' })}
        confirmLabel={t('files.trash')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => void doTrash()}
        onCancel={() => setTrash(null)}
      />
      <ConfirmDialog
        open={closing !== null}
        title={t('files.closeDirtyTitle')}
        message={t('files.closeDirtyBody', { name: closing ? baseName(closing) : '' })}
        confirmLabel={t('files.discard')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          if (closing) closeTab(tree, closing)
          setClosing(null)
        }}
        onCancel={() => setClosing(null)}
      />
    </RightDrawer>
  )
}
