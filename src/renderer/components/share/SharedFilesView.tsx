import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Eye, FolderTree, PencilLine, Search } from 'lucide-react'
import { baseName } from '@shared/files'
import type { ShareLinkView } from '@shared/share-guest'
import { useT } from '@/i18n'
import { closeTab, openFile, reloadTab, reloadTree, setActiveTab, setFilesIo, toggleDir, useFilesStore, wsFiles } from '@/lib/filesStore'
import { liveKeyOf, shareFilesIo, shareFilesKey } from '@/lib/shareGuestExtras'
import { useShareGuestStore } from '@/lib/shareGuestStore'
import { toast } from '@/lib/toast'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { isMarkdownName, languageLabel } from '@/components/editor/languages'
import { useEditorLook } from '@/components/editor/useEditorLook'
import { FILES_ERROR_KEY, TabButton, TreeItem, flatten } from '@/components/files/fileTreeParts'
import { SharedMarkdown } from './chat/Markdown'

/**
 * The Files of a shared workspace, read only (app 2.6.0): the host's folder
 * as a tree, files in tabs with the code editor read-only, Markdown with a
 * preview (links through ConfirmLinkDialog) and images. No create, rename,
 * delete, reveal or insert: the share protocol has no write for files, and
 * the host never lists `.git` nor secret files (.env, keys). A long file shows
 * its start (`partial`). While the drawer is open the host pushes changes
 * (`filesWatch`), and a new session or a resume reads everything again.
 */
export function SharedFilesView({ link, hostLabel }: { link: ShareLinkView; hostLabel: string }) {
  const t = useT()
  const look = useEditorLook()
  const linkId = link.id
  const key = shareFilesKey(linkId)
  const liveKey = liveKeyOf(link)
  const ws = useFilesStore((s) => wsFiles(s, key))
  const confirmLink = useShareGuestStore((s) => s.confirmLink)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [preview, setPreview] = useState(true)

  // The tree reads through this link; the host pushes changes while the drawer shows.
  useEffect(() => {
    setFilesIo(key, shareFilesIo(linkId))
    window.snApi.share.guest.filesWatch({ linkId, on: true })
    return () => window.snApi.share.guest.filesWatch({ linkId, on: false })
  }, [key, linkId])

  // Every new session (or a resume from pause) reads the folders shown and the open files again.
  useEffect(() => {
    if (liveKey === null) return
    void reloadTree(key)
    for (const tab of wsFiles(useFilesStore.getState(), key).tabs) void reloadTab(key, tab.rel)
  }, [liveKey, key])

  const rows = useMemo(() => flatten(ws.dirs, ws.expanded, filter), [ws.dirs, ws.expanded, filter])
  const active = ws.tabs.find((tab) => tab.rel === ws.active) ?? null
  const isMd = !!active && active.kind === 'text' && isMarkdownName(active.rel)
  const rootError = ws.dirs['']?.error

  const open = async (rel: string): Promise<void> => {
    setSelected(rel)
    const err = await openFile(key, rel)
    if (err) toast.error(t(FILES_ERROR_KEY[err]), { dedupeKey: `share-files:${linkId}` })
  }

  const onTreeKey = (e: ReactKeyboardEvent): void => {
    if (!selected) return
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows.find((r) => r.rel === selected)
      if (row?.kind === 'dir') toggleDir(key, row.rel)
      else if (row) void open(row.rel)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = rows.findIndex((r) => r.rel === selected)
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) setSelected(next.rel)
    }
  }

  return (
    <div data-shared-files className="flex min-h-0 min-w-0 flex-1">
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
        <div role="tree" aria-label={t('shareGuest.files.title')} tabIndex={0} className="min-h-0 flex-1 overflow-auto pb-2 outline-none" data-files-tree>
          {rootError ? (
            <div className="space-y-2 px-3 py-4 text-center text-[11px] text-text-secondary" data-files-root-error={rootError}>
              <p>{t(rootError === 'no_root' ? 'shareGuest.files.noFolder' : FILES_ERROR_KEY[rootError])}</p>
              <button type="button" onClick={() => void reloadTree(key)} className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card">
                {t('shareGuest.extras.retry')}
              </button>
            </div>
          ) : (
            <>
              {rows.map((r) => (
                <TreeItem
                  key={r.rel}
                  row={r}
                  selected={selected === r.rel}
                  current={ws.active === r.rel}
                  onClick={() => {
                    setSelected(r.rel)
                    if (r.kind === 'dir') toggleDir(key, r.rel)
                    else void open(r.rel)
                  }}
                />
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
              <TabButton key={tab.rel} tab={tab} active={tab.rel === ws.active} onPick={() => setActiveTab(key, tab.rel)} onClose={() => closeTab(key, tab.rel)} closeLabel={t('files.closeTab')} />
            ))}
          </div>
        )}
        {active ? (
          <>
            {active.external === 'deleted' && (
              <p role="status" data-file-external="deleted" className="shrink-0 border-b border-border bg-state-action/10 px-3 py-1.5 text-xs text-text-primary">
                {t('shareGuest.files.deleted')}
              </p>
            )}
            {active.partial && (
              <p role="status" data-shared-file-partial className="shrink-0 border-b border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary">
                {t('shareGuest.files.partial')}
              </p>
            )}
            <div className="relative min-h-0 flex-1">
              {active.kind === 'image' ? (
                <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--color-bg-secondary)_0_25%,var(--color-bg-primary)_0_50%)] bg-[length:16px_16px] p-4" data-file-image>
                  <img src={active.dataUrl} alt={baseName(active.rel)} className="max-h-full max-w-full object-contain" />
                </div>
              ) : preview && isMd ? (
                <div className="h-full overflow-y-auto px-6 py-4" data-file-preview>
                  <SharedMarkdown text={active.text} onLink={(href) => confirmLink(href, hostLabel)} />
                </div>
              ) : (
                ws.tabs
                  .filter((tab) => tab.kind === 'text')
                  .map((tab) => (
                    <div key={`${tab.rel}:${tab.seq}`} className={tab.rel !== ws.active ? 'absolute inset-0 hidden' : 'absolute inset-0'}>
                      <CodeEditor
                        docKey={`${tab.rel}:${tab.seq}`}
                        initialText={tab.initial}
                        fileName={baseName(tab.rel)}
                        readOnly
                        tokens={look.tokens}
                        light={look.light}
                        fontFamily={look.fontFamily}
                        fontSize={look.fontSize}
                        onCursor={(line, col) => {
                          if (tab.rel === useFilesStore.getState().byWs[key]?.active) setCursor({ line, col })
                        }}
                      />
                    </div>
                  ))
              )}
            </div>
            <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-text-secondary" data-files-status>
              <span className="min-w-0 flex-1 truncate">{active.rel}</span>
              <span className="text-state-action">{t('shareGuest.files.readOnly')}</span>
              {active.kind === 'text' && (
                <>
                  <span>{t('files.cursor', { line: cursor.line, col: cursor.col })}</span>
                  <span>{languageLabel(baseName(active.rel), t('files.plainText'))}</span>
                  <span>{active.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
                  <span>{active.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
                </>
              )}
              {isMd && (
                <button type="button" onClick={() => setPreview((v) => !v)} className="flex items-center gap-1 hover:text-text-primary" data-file-preview-toggle>
                  {preview ? <PencilLine size={11} /> : <Eye size={11} />}
                  {preview ? t('shareGuest.files.source') : t('files.preview')}
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <FolderTree size={28} className="text-text-secondary/60" />
            <p className="max-w-xs text-xs text-text-secondary">{t('shareGuest.files.intro', { host: hostLabel })}</p>
          </div>
        )}
      </section>
    </div>
  )
}

