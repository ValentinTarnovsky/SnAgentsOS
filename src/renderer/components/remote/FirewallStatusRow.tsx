import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import type { FirewallFixRes, FirewallStatus } from '@shared/ipc-contract'
import { BRAND } from '@shared/brand'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'

type Tone = 'ok' | 'warn' | 'bad' | 'muted'

const TONE: Record<Tone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  bad: 'border-red-500/30 bg-red-500/10 text-red-300',
  muted: 'border-border bg-bg-secondary text-text-secondary',
}

const FIX_NOTE: Record<string, MessageKey> = {
  cancelled: 'remote.fw.cancelled',
  failed: 'remote.fw.failed',
  timeout: 'remote.fw.failed',
  notFixed: 'remote.fw.notFixed',
}

const UNKNOWN: FirewallStatus = {
  ok: false,
  profile: 'unknown',
  ruleFound: false,
  state: 'unknown',
  port: 0,
  endpoints: [],
  blockingRules: [],
  ruleScope: 'port',
  fixable: false,
  checkedAt: 0,
}

/**
 * Windows firewall and network profile row (E2-FR-38/39), under the QR in the
 * pairing modal and in Settings > Remote. Checks on mount (main caches it for
 * 60s) and renders one of: OK (green); Public network (amber, opens the
 * network settings); blocked (red, Fix when fixable, else the rule that cannot
 * be removed); no rule (amber, Create rule); not checked (grey, the static
 * hint). Fix asks for UAC; a cancelled prompt shows "Cancelled". Renders
 * nothing off Windows.
 */
/** The two calls the row needs: the phone server's (default) or the Share listener's (snApi.share.host). */
export interface FirewallRowApi {
  firewallCheck(force?: boolean): Promise<FirewallStatus>
  firewallFix(): Promise<FirewallFixRes>
}

export function FirewallStatusRow({ className, api }: { className?: string; api?: FirewallRowApi }) {
  const t = useT()
  const fw: FirewallRowApi = api ?? window.snApi.remote
  const [status, setStatus] = useState<FirewallStatus | null>(null)
  const [busy, setBusy] = useState<'check' | 'fix' | null>('check')
  const [note, setNote] = useState<MessageKey | null>(null)

  const check = useCallback((force: boolean) => {
    setBusy('check')
    setNote(null)
    let alive = true
    fw
      .firewallCheck(force)
      .then((s) => {
        if (alive) setStatus(s)
      })
      // A failed IPC call is "could not check" (grey hint), never a spinner forever.
      .catch(() => {
        if (alive) setStatus((prev) => prev ?? UNKNOWN)
      })
      .finally(() => {
        if (alive) setBusy(null)
      })
    return () => {
      alive = false
    }
    // `fw` follows `api` (or the stable snApi.remote).
  }, [api])

  useEffect(() => check(false), [check])

  const fix = (): void => {
    setBusy('fix')
    setNote(null)
    fw
      .firewallFix()
      .then((res: FirewallFixRes) => {
        if (res.status) setStatus(res.status)
        if (!res.ok) setNote(FIX_NOTE[res.cancelled ? 'cancelled' : res.error ?? 'failed'] ?? 'remote.fw.failed')
      })
      .catch(() => setNote('remote.fw.failed'))
      .finally(() => setBusy(null))
  }

  if (status?.state === 'unsupported') return null

  const app = BRAND.productName
  let tone: Tone = 'muted'
  let icon = <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />
  let text = t('remote.fw.checking')
  let action: { label: string; run: () => void; testId: string } | null = null
  let detail: string | null = null

  if (status) {
    switch (status.state) {
      case 'ok':
        tone = 'ok'
        icon = <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        text = t('remote.fw.ok', { port: status.port })
        break
      case 'publicProfile': {
        tone = 'warn'
        icon = <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        const net = status.endpoints.find((e) => e.kind === 'lan' && e.profile === 'Public')
        text = t('remote.fw.public', { network: net?.networkName || net?.ip || '?' })
        action = { label: t('remote.fw.openNetwork'), run: () => window.snApi.remote.openNetworkSettings(), testId: 'network' }
        break
      }
      case 'blocked': {
        tone = 'bad'
        icon = <ShieldX size={14} className="mt-0.5 shrink-0" />
        text = t('remote.fw.blocked', { app })
        if (status.fixable) {
          action = { label: t('remote.fw.fix'), run: fix, testId: 'fix' }
        } else {
          const rule = status.blockingRules.find((b) => b.scope === 'port') ?? status.blockingRules[0]
          detail = t('remote.fw.blockedManual', { rule: rule?.displayName || rule?.name || '?' })
        }
        break
      }
      case 'noRule':
        tone = 'warn'
        icon = <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        text = t('remote.fw.noRule', { app, port: status.port })
        action = { label: t('remote.fw.createRule'), run: fix, testId: 'create' }
        break
      default:
        tone = 'muted'
        icon = <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        text = t('remote.firewallHint', { app })
    }
    if (action && action.run === fix && status.ruleScope === 'port') detail = t('remote.fw.scopePort', { port: status.port })
  }

  return (
    <div
      data-fw-state={status?.state ?? 'checking'}
      className={cn('rounded-card border px-3 py-2 text-[11px] leading-relaxed', TONE[tone], className)}
    >
      <div className="flex items-start gap-2">
        {busy === 'fix' ? <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" /> : icon}
        <span className="min-w-0 flex-1">
          {busy === 'fix' ? t('remote.fw.fixing') : text}
          {detail && busy !== 'fix' && <span className="mt-0.5 block opacity-80">{detail}</span>}
          {note && busy === null && (
            <span data-fw-note className="mt-0.5 block font-medium">
              {t(note)}
            </span>
          )}
        </span>
        {status && busy === null && (
          <button
            type="button"
            data-fw-action="recheck"
            onClick={() => check(true)}
            title={t('remote.fw.recheck')}
            className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
          >
            <RefreshCw size={12} />
          </button>
        )}
      </div>
      {action && busy === null && (
        <button
          type="button"
          data-fw-action={action.testId}
          onClick={action.run}
          className="mt-1.5 flex items-center gap-1.5 rounded-btn border border-border bg-card px-2 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-accent-violet/50"
        >
          {action.testId === 'network' && <ExternalLink size={12} />}
          {action.label}
        </button>
      )}
    </div>
  )
}
