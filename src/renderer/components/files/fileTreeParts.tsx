/**
 * Pieces of the file tree the local Files drawer and a share guest's
 * read-only Files drawer (app 2.6.0) both draw: the file icons, the visible
 * rows of the loaded folders, a tree row and an editor tab.
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronRight, File, FileCode2, FileImage, FileJson, FileText, Folder, FolderOpen, X } from 'lucide-react'
import { baseName, extOf, joinRel, type FilesError } from '@shared/files'
import type { MessageKey } from '@/i18n'
import { isDirty, type FileTab } from '@/lib/filesStore'
import { cn } from '@/lib/cn'

export const FILES_ERROR_KEY: Record<FilesError, MessageKey> = {
  no_root: 'files.err.no_root',
  not_found: 'files.err.not_found',
  denied_path: 'files.err.denied_path',
  invalid: 'files.err.invalid',
  binary: 'files.err.binary',
  too_large: 'files.err.too_large',
  conflict: 'files.err.conflict',
  exists: 'files.err.exists',
  io: 'files.err.io',
}

const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'lua', 'sh', 'ps1', 'css', 'scss', 'html', 'vue', 'sql', 'xml', 'gradle', 'groovy'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

export function FileIcon({ name, size = 14 }: { name: string; size?: number }) {
  const ext = extOf(name)
  if (ext === 'json' || ext === 'jsonc') return <FileJson size={size} className="shrink-0 text-[#e5c07b]" />
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return <FileText size={size} className="shrink-0 text-accent-blue" />
  if (IMAGE_EXT.has(ext)) return <FileImage size={size} className="shrink-0 text-[#c678dd]" />
  if (CODE_EXT.has(ext)) return <FileCode2 size={size} className="shrink-0 text-accent-violet" />
  return <File size={size} className="shrink-0 text-text-secondary" />
}

export interface Row {
  rel: string
  name: string
  kind: 'file' | 'dir'
  depth: number
  open: boolean
}

/** The visible rows: expanded folders' children, or every loaded match of the filter (with its folders). */
export function flatten(dirs: Record<string, { entries: { name: string; kind: 'file' | 'dir' }[] }>, expanded: string[], filter: string): Row[] {
  const rows: Row[] = []
  const q = filter.trim().toLowerCase()
  const matches = (rel: string, name: string, kind: 'file' | 'dir'): boolean => {
    if (!q) return true
    if (name.toLowerCase().includes(q)) return true
    if (kind !== 'dir') return false
    const kids = dirs[rel]?.entries ?? []
    return kids.some((k) => matches(joinRel(rel, k.name), k.name, k.kind))
  }
  const walk = (dir: string, depth: number): void => {
    for (const e of dirs[dir]?.entries ?? []) {
      const rel = joinRel(dir, e.name)
      if (!matches(rel, e.name, e.kind)) continue
      const open = e.kind === 'dir' && (q ? !!dirs[rel] : expanded.includes(rel))
      rows.push({ rel, name: e.name, kind: e.kind, depth, open })
      if (open) walk(rel, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

/** One row of the tree: a folder (chevron) or a file (its icon). */
export function TreeItem({ row, selected, current, onClick, onContextMenu }: { row: Row; selected: boolean; current: boolean; onClick: () => void; onContextMenu?: (e: ReactMouseEvent) => void }) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={row.kind === 'dir' ? row.open : undefined}
      aria-selected={selected}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12.5px] transition-colors',
        selected ? 'bg-accent-violet/15 text-text-primary' : 'text-text-primary/90 hover:bg-bg-secondary',
        current && 'font-medium',
      )}
      style={{ paddingLeft: 6 + row.depth * 12 }}
      data-file-row={row.rel}
      data-file-kind={row.kind}
    >
      {row.kind === 'dir' ? (
        <>
          {row.open ? <ChevronDown size={12} className="shrink-0 text-text-secondary" /> : <ChevronRight size={12} className="shrink-0 text-text-secondary" />}
          {row.open ? <FolderOpen size={14} className="shrink-0 text-[#d19a66]" /> : <Folder size={14} className="shrink-0 text-[#d19a66]" />}
        </>
      ) : (
        <>
          <span className="w-3 shrink-0" />
          <FileIcon name={row.name} />
        </>
      )}
      <span className="min-w-0 truncate">{row.name}</span>
    </button>
  )
}

export function TabButton({ tab, active, onPick, onClose, closeLabel }: { tab: FileTab; active: boolean; onPick: () => void; onClose: () => void; closeLabel: string }) {
  const dirty = isDirty(tab)
  const ref = useRef<HTMLDivElement | null>(null)
  // Scrolls the tab strip only: scrollIntoView would also scroll every ancestor, and while
  // the drawer slides in from translateX(100%) that shifted the whole app shell (v2.2.1).
  useEffect(() => {
    const el = ref.current
    const strip = el?.parentElement
    if (!active || !el || !strip) return
    const tab = el.getBoundingClientRect()
    const box = strip.getBoundingClientRect()
    if (tab.left < box.left) strip.scrollLeft -= box.left - tab.left
    else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right
  }, [active])
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        // Middle click closes, like an editor.
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      className={cn(
        'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 text-xs',
        active ? 'bg-bg-primary text-text-primary' : 'text-text-secondary hover:text-text-primary',
      )}
      onClick={onPick}
      data-file-tab={tab.rel}
      data-dirty={dirty ? 'true' : 'false'}
    >
      <FileIcon name={baseName(tab.rel)} size={13} />
      <span className="max-w-[180px] truncate">{baseName(tab.rel)}</span>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="relative flex h-4 w-4 items-center justify-center rounded hover:bg-card"
      >
        {dirty ? (
          <>
            <span className="h-2 w-2 rounded-full bg-text-primary group-hover:hidden" />
            <X size={12} className="hidden group-hover:block" />
          </>
        ) : (
          <X size={12} className={cn(!active && 'opacity-0 group-hover:opacity-100')} />
        )}
      </button>
    </div>
  )
}
