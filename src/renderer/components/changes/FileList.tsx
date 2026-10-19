import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ChevronRight, Copy, ExternalLink, FolderOpen, MessageSquare, SquareTerminal } from 'lucide-react'
import type { GitArea, GitFileEntry } from '@shared/git-types'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { groupFiles, rowCounts, rowKey, splitName, stepRow, visibleRows } from '@/lib/changes'
import { encodeInternalPath, INTERNAL_PATH_MIME } from '@/lib/dragNonce'

/** Status letter colors: conflicts red, additions green, deletions red, the rest muted. */
function statusClass(s: GitFileEntry['status']): string {
  if (s === 'U' || s === 'D') return 'text-ansi-red'
  if (s === 'A' || s === '?') return 'text-ansi-green'
  if (s === 'R' || s === 'C') return 'text-accent-blue'
  return 'text-state-action'
}

export interface RowActions {
  copyRelative: (f: GitFileEntry) => void
  copyAbsolute: (f: GitFileEntry) => void
  open: (f: GitFileEntry) => void
  reveal: (f: GitFileEntry) => void
  insert: (f: GitFileEntry) => void
  /** Absolute path a row drag carries (E7-FR-04). */
  absPath: (f: GitFileEntry) => string
}

/**
 * File list of the Changes panel (E7-FR-12): collapsible Conflicts / Staged /
 * Unstaged / Untracked sections with counters (empty ones hidden), one row
 * per file with its status letter, bold name, muted folder and `+a -d`.
 * Arrows move, Enter opens the diff. Rows drag their absolute path to a pane
 * and have a context menu (FR-15).
 */
export function FileList({
  files,
  total,
  truncated,
  selected,
  collapsed,
  onToggleSection,
  onSelect,
  actions,
  noteCounts,
  sectionLabel,
}: {
  files: GitFileEntry[]
  /** Every changed entry (more than `files.length` when truncated). */
  total: number
  truncated: boolean
  selected: string | null
  collapsed: ReadonlySet<GitArea>
  onToggleSection: (area: GitArea) => void
  onSelect: (f: GitFileEntry) => void
  actions: RowActions
  /** Unresolved review notes per row (`area:path`), shown as a badge (E7-FR-17). */
  noteCounts?: Record<string, number>
  /** Overrides a section title ("Against base" for the tracked files of that mode, E7-FR-35). */
  sectionLabel?: (area: GitArea) => string | undefined
}) {
  const t = useT()
  const labelOf = (area: GitArea): string => sectionLabel?.(area) ?? t(`changes.section.${area}`)
  const [cursor, setCursor] = useState<string | null>(selected)
  const [menu, setMenu] = useState<{ x: number; y: number; file: GitFileEntry } | null>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const sections = groupFiles(files)

  // The cursor follows the selection when it changes from outside (Alt+Down/Up).
  useEffect(() => {
    if (selected) setCursor(selected)
  }, [selected])

  const moveTo = (f: GitFileEntry | null): void => {
    if (!f) return
    const k = rowKey(f)
    setCursor(k)
    rowRefs.current.get(k)?.focus()
    rowRefs.current.get(k)?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const rows = visibleRows(files, collapsed)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      moveTo(stepRow(rows, cursor, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      moveTo(e.key === 'Home' ? rows[0] ?? null : rows[rows.length - 1] ?? null)
    }
  }

  const onDragStart = (e: DragEvent<HTMLButtonElement>, f: GitFileEntry): void => {
    // In-app path drag: nonce + absolute path, validated again by the pane on drop.
    e.dataTransfer.setData(INTERNAL_PATH_MIME, encodeInternalPath(actions.absPath(f)))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const menuItems = (f: GitFileEntry): ContextMenuItem[] => [
    { label: t('changes.menu.copyRelative'), icon: Copy, onClick: () => actions.copyRelative(f) },
    { label: t('changes.menu.copyAbsolute'), icon: Copy, onClick: () => actions.copyAbsolute(f) },
    { label: t('changes.menu.open'), icon: ExternalLink, onClick: () => actions.open(f), separated: true },
    { label: t('changes.menu.reveal'), icon: FolderOpen, onClick: () => actions.reveal(f) },
    { label: t('changes.menu.insert'), icon: SquareTerminal, onClick: () => actions.insert(f), separated: true },
  ]

  return (
    <div
      className="min-h-0 overflow-y-auto py-1"
      onKeyDown={(e) => {
        // With the menu open, Esc only closes the menu (the ContextMenu listens on window).
        if (menu && e.key === 'Escape') {
          e.stopPropagation()
          return
        }
        onKeyDown(e)
      }}
      data-changes-files
    >
      {sections.map((sec) => {
        const isCollapsed = collapsed.has(sec.area)
        return (
          <div key={sec.area} role="group" aria-label={labelOf(sec.area)} data-changes-section={sec.area}>
            <button
              type="button"
              onClick={() => onToggleSection(sec.area)}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary hover:text-text-primary"
            >
              <ChevronRight size={12} className={cn('shrink-0 transition-transform', !isCollapsed && 'rotate-90')} />
              <span className="truncate">{labelOf(sec.area)}</span>
              <span className="ml-1 rounded-full bg-bg-secondary px-1.5 font-mono text-[10px] font-normal leading-4">{sec.files.length}</span>
            </button>
            {!isCollapsed &&
              sec.files.map((f) => {
                const k = rowKey(f)
                const { name, dir } = splitName(f.path)
                const counts = rowCounts(f)
                const isSel = k === selected
                return (
                  <button
                    key={k}
                    ref={(el) => {
                      if (el) rowRefs.current.set(k, el)
                      else rowRefs.current.delete(k)
                    }}
                    type="button"
                    draggable
                    onDragStart={(e) => onDragStart(e, f)}
                    onClick={() => {
                      setCursor(k)
                      onSelect(f)
                    }}
                    onFocus={() => setCursor(k)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCursor(k)
                      setMenu({ x: e.clientX, y: e.clientY, file: f })
                    }}
                    tabIndex={k === (cursor ?? selected ?? rowKey(visibleRows(files, collapsed)[0] ?? f)) ? 0 : -1}
                    aria-current={isSel || undefined}
                    title={f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path}
                    data-changes-row={k}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2 py-[3px] pl-6 pr-2 text-left text-xs outline-none',
                      isSel ? 'bg-accent-violet/15 text-text-primary' : 'text-text-primary hover:bg-card',
                      'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-violet',
                    )}
                  >
                    <span className={cn('w-3 shrink-0 text-center font-mono font-semibold', statusClass(f.status))} aria-label={t(`changes.status.${f.status}`)}>
                      {f.status}
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                      {f.oldPath ? (
                        <span className="truncate font-semibold">
                          {splitName(f.oldPath).name} <span className="font-normal text-text-secondary">-&gt;</span> {name}
                        </span>
                      ) : (
                        <span className="shrink-0 truncate font-semibold" style={{ maxWidth: '70%' }}>
                          {name}
                        </span>
                      )}
                      {dir && <span className="min-w-0 truncate text-text-secondary">{dir}</span>}
                    </span>
                    {!!noteCounts?.[k] && (
                      <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-accent-violet" aria-label={t('notes.rowCount', { count: noteCounts[k] })} data-row-notes={noteCounts[k]}>
                        <MessageSquare size={10} />
                        {noteCounts[k]}
                      </span>
                    )}
                    {counts && (
                      <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
                        {counts === 'bin' ? (
                          <span className="text-text-secondary">bin</span>
                        ) : (
                          <>
                            <span className="text-ansi-green">+{f.added ?? 0}</span> <span className="text-ansi-red">-{f.removed ?? 0}</span>
                          </>
                        )}
                      </span>
                    )}
                  </button>
                )
              })}
          </div>
        )
      })}
      {truncated && (
        <p className="px-3 py-1.5 text-[11px] text-text-secondary" data-changes-truncated>
          {t('changes.truncated', { shown: files.length, total })}
        </p>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.file)} label={t('changes.menu.label')} onClose={() => setMenu(null)} />}
    </div>
  )
}
