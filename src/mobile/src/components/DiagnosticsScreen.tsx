/**
 * Diagnostics as a pushed screen (E2-FR-36): pass/warn/fail checks (paired on
 * this origin, route type, server responds, last close, versions, retries),
 * "What this suggests", a "Common problems" accordion, the scrollable log
 * (last 200 lines, already redacted) and [Copy report]. Opened from the
 * tappable connection banner and from the connecting screen; the entries in
 * Settings and on the header dot call openDiagnostics() too.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, RefreshCw, XCircle } from 'lucide-react'
import { PushScreen } from './PushScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { getStoredAuth } from '../lib/auth'
import { closeDiagnostics, formatEntry, useDiagStore, entries } from '../lib/connLog'
import {
  buildChecks,
  buildReport,
  copyText,
  probeServer,
  suggestions,
  type CheckResult,
  type DiagCheck,
  type DiagInput,
  type ServerProbe,
} from '../lib/diagnostics'
import { t, type MobileMessageKey } from '../lib/i18n'

const BUNDLE_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

/** Number of entries in the "Common problems" accordion. */
export const FAQ_COUNT = 6

function hostOf(): { host: string; hostname: string } {
  if (typeof location === 'undefined') return { host: '', hostname: '' }
  return { host: location.host, hostname: location.hostname }
}

/** Everything the checks read, gathered from the stores at call time. */
export function currentDiagInput(server: ServerProbe): DiagInput {
  const s = useRemoteStore.getState()
  const d = useDiagStore.getState()
  return {
    paired: getStoredAuth() !== null,
    hostname: hostOf().hostname,
    live: s.phase === 'live' && client.isOpen(),
    server,
    lastClose: d.lastClose,
    abnormalStreak: d.abnormalStreak,
    desktopVersion: s.appVersion,
    bundleVersion: BUNDLE_VERSION,
    retries: d.retries,
    lastConnectedAt: s.lastConnectedAt,
    locked: s.phase === 'locked',
    now: Date.now(),
  }
}

export function describeCheck(c: DiagCheck): string {
  return t(c.detail.key as MobileMessageKey, c.detail.vars)
}

/** The plain-text report of [Copy report]. */
export function currentReport(server: ServerProbe): string {
  const input = currentDiagInput(server)
  return buildReport({
    ...input,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    host: hostOf().host,
    checks: buildChecks(input),
    entries: entries(),
    describe: describeCheck,
  })
}

/**
 * "Server responds": the RTT of a ping on a live socket, else a bare probe
 * socket that has to open within 4s. Runs while `active`; rerun() repeats it.
 */
export function useServerProbe(active: boolean): { server: ServerProbe; rerun: () => void } {
  const [server, setServer] = useState<ServerProbe>({ kind: 'pending' })
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setServer({ kind: 'pending' })
    void (async () => {
      const rtt = await client.measureRtt()
      if (cancelled) return
      if (rtt != null) {
        setServer({ kind: 'rtt', ms: rtt })
        return
      }
      const probe = await probeServer(hostOf().host)
      if (!cancelled) setServer(probe)
    })()
    return () => {
      cancelled = true
    }
  }, [active, round])
  const rerun = useCallback(() => setRound((r) => r + 1), [])
  return { server, rerun }
}

/** [Copy report] with an inline "Copied" confirmation (no toast host needed). */
export function CopyReportButton({ server, className }: { server: ServerProbe; className?: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const id = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(id)
  }, [state])
  return (
    <button
      type="button"
      data-action="copy-report"
      onClick={() => {
        void copyText(currentReport(server)).then((ok) => setState(ok ? 'copied' : 'failed'))
      }}
      className={clsx(
        'flex h-11 w-full items-center justify-center gap-2 rounded-btn border border-border bg-bg-secondary px-4 text-sm font-medium text-text-primary active:bg-card',
        className,
      )}
    >
      <Copy size={15} />
      {state === 'copied' ? t('diag.copied') : state === 'failed' ? t('diag.copyFailed') : t('diag.copy')}
    </button>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactNode {
  return (
    <section data-diag-section={id} className="mb-6">
      <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</h3>
      {children}
    </section>
  )
}

const RESULT_ICON: Record<CheckResult, ReactNode> = {
  pass: <CheckCircle2 size={16} className="shrink-0 text-green-400" />,
  warn: <AlertTriangle size={16} className="shrink-0 text-amber-400" />,
  fail: <XCircle size={16} className="shrink-0 text-red-400" />,
}

function CheckRow({ check }: { check: DiagCheck }): ReactNode {
  return (
    <div data-check={check.id} data-result={check.result} className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5">{RESULT_ICON[check.result]}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text-primary">{t(`diag.check.${check.id}` as MobileMessageKey)}</span>
        <span className="block break-words text-[11px] leading-snug text-text-secondary">{describeCheck(check)}</span>
      </span>
    </div>
  )
}

function Faq({ n }: { n: number }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div data-faq={n} className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-text-primary active:bg-card"
      >
        <span className="min-w-0 flex-1">{t(`diag.faq${n}.q` as MobileMessageKey)}</span>
        <ChevronDown size={16} className={clsx('shrink-0 text-text-secondary transition-transform', open && 'rotate-180')} />
      </button>
      {open && <p className="px-4 pb-3 text-[12px] leading-relaxed text-text-secondary">{t(`diag.faq${n}.a` as MobileMessageKey)}</p>}
    </div>
  )
}

/** The screen body, mountable without the PushScreen chrome (tests). */
export function DiagnosticsBody({ active = true }: { active?: boolean }): ReactNode {
  const log = useDiagStore((s) => s.entries)
  // Re-render on the connection facts the checks read.
  useDiagStore((s) => s.lastClose)
  useDiagStore((s) => s.retries)
  useRemoteStore((s) => s.phase)
  useRemoteStore((s) => s.connected)
  const { server, rerun } = useServerProbe(active)
  const input = currentDiagInput(server)
  const checks = buildChecks(input)
  const sugs = suggestions(input)

  return (
    <div data-diagnostics>
      <Section id="checks" title={t('diag.checks')}>
        <div className="divide-y divide-border rounded-card border border-border bg-bg-secondary">
          {checks.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </div>
        <button
          type="button"
          data-action="rerun"
          onClick={rerun}
          className="mt-2 flex h-10 items-center gap-1.5 rounded-btn px-2 text-xs font-medium text-text-secondary active:bg-card"
        >
          <RefreshCw size={13} />
          {t('diag.rerun')}
        </button>
      </Section>
      <Section id="suggest" title={t('diag.suggest')}>
        <div data-suggestions className="rounded-card border border-border bg-bg-secondary px-4 py-3">
          {sugs.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('diag.sug.none')}</p>
          ) : (
            <ul className="list-disc space-y-1.5 pl-4 text-sm text-text-primary">
              {sugs.map((id) => (
                <li key={id} data-suggestion={id}>
                  {t(`diag.sug.${id}` as MobileMessageKey)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
      <Section id="faq" title={t('diag.faq')}>
        <div className="rounded-card border border-border bg-bg-secondary">
          {Array.from({ length: FAQ_COUNT }, (_, i) => (
            <Faq key={i} n={i + 1} />
          ))}
        </div>
      </Section>
      <Section id="log" title={t('diag.log', { n: log.length })}>
        <div
          data-diag-log
          role="log"
          className="max-h-[50vh] overflow-y-auto rounded-card border border-border bg-bg-secondary px-3 py-2 font-mono text-[10px] leading-relaxed text-text-secondary"
        >
          {log.length === 0 ? (
            <span className="opacity-70">{t('diag.logEmpty')}</span>
          ) : (
            log.map((e, i) => (
              <div
                key={`${e.t}-${i}`}
                className={clsx('break-all', e.level === 'error' ? 'text-red-400' : e.level === 'warn' ? 'text-amber-400' : '')}
              >
                {formatEntry(e)}
              </div>
            ))
          )}
        </div>
      </Section>
      <CopyReportButton server={server} />
    </div>
  )
}

export function DiagnosticsScreen(): ReactNode {
  const open = useDiagStore((s) => s.open)
  return (
    <PushScreen id="diagnostics" open={open} onClose={closeDiagnostics} title={t('diag.title')}>
      <DiagnosticsBody active={open} />
    </PushScreen>
  )
}
