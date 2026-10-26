/**
 * The preview step of "Nuevo equipo" (app 2.7.0, E10 B1): the exact files
 * main renders from the draft, one tab per file, as plain text. Definition
 * problems block the write; the warnings say what the access of the roles
 * means. The files are created in .snagentsos/team/ and never committed.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { SetupPreview as SetupPreviewData, SetupWarning } from '@shared/team-protocol'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { DefIssueList } from './TeamDiffView'

const WARNING_KEY: Record<SetupWarning, MessageKey> = {
  totalBypass: 'teams.setup.warning.totalBypass',
  codexTotal: 'teams.setup.warning.codexTotal',
  codexReadonlyBlock: 'teams.setup.warning.codexReadonlyBlock',
  noVerify: 'teams.setup.warning.noVerify',
  notCommitted: 'teams.setup.warning.notCommitted',
  userAllow: 'teams.setup.warning.userAllow',
}

/** What the access of the roles means, in amber (edit step from the draft, preview step from main). */
export function SetupWarnings({ warnings }: { warnings: readonly SetupWarning[] }) {
  const t = useT()
  if (warnings.length === 0) return null
  return (
    <ul data-setup-warnings className="space-y-1">
      {warnings.map((w) => (
        <li key={w} data-setup-warning={w} className="flex min-w-0 items-start gap-1.5 text-xs text-amber-400">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{t(WARNING_KEY[w])}</span>
        </li>
      ))}
    </ul>
  )
}

export function SetupPreview({ preview, repoName }: { preview: SetupPreviewData; repoName: string }) {
  const t = useT()
  const [sel, setSel] = useState<string | null>(preview.files[0]?.rel ?? null)
  // A new preview (the stale one was made again) starts on its first file.
  useEffect(() => {
    setSel((cur) => (cur && preview.files.some((f) => f.rel === cur) ? cur : preview.files[0]?.rel ?? null))
  }, [preview.hash, preview.files])
  const file = preview.files.find((f) => f.rel === sel) ?? preview.files[0]

  return (
    <div data-setup-preview={preview.hash} className="min-w-0 space-y-3">
      <p className="text-xs text-text-secondary">{t('teams.setup.preview.intro', { repo: repoName })}</p>
      <DefIssueList issues={preview.issues} title={t('teams.setup.preview.issues')} />
      <SetupWarnings warnings={preview.warnings} />
      {preview.files.length > 0 && (
        <div className="min-w-0 overflow-hidden rounded-btn border border-border">
          <div role="tablist" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-bg-secondary/60">
            {preview.files.map((f) => {
              const on = f.rel === file?.rel
              return (
                <button
                  key={f.rel}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  data-setup-preview-file={f.rel}
                  onClick={() => setSel(f.rel)}
                  className={cn(
                    'shrink-0 whitespace-nowrap border-r border-border px-2.5 font-mono text-[11px] transition-colors',
                    on ? 'bg-bg-primary text-text-primary' : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {f.rel}
                </button>
              )
            })}
          </div>
          {file && (
            <div role="tabpanel" className="min-w-0 bg-bg-primary">
              <pre
                data-setup-preview-text={file.rel}
                className="max-h-[38vh] min-w-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-[16px] text-text-primary"
              >
                {file.text}
              </pre>
              <div className="border-t border-border px-3 py-1 text-[11px] tabular-nums text-text-secondary">
                {t('teams.setup.preview.bytes', { n: file.bytes })}
              </div>
            </div>
          )}
        </div>
      )}
      <p data-setup-note className="text-xs text-text-secondary">{t('teams.setup.preview.note', { n: preview.files.length })}</p>
    </div>
  )
}
