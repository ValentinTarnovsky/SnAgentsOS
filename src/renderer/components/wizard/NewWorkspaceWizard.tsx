import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import type { GridPreset } from '@shared/types'
import { useAppStore, type WizardInitialDraft } from '@/lib/store'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { isFromToast } from '@/lib/toast'
import { setWizardDraftCwd } from '@/lib/openRequest'
import { StepStart } from './StepStart'
import { StepLayout } from './StepLayout'
import { StepAgents } from './StepAgents'
import { WizardFooter } from './WizardFooter'
import type { WizardDraft } from './types'
import { initialWizardFocus, trapTabIndex, wizardKeyAction } from './wizardKeys'
import { takeFlowFocus } from './flowFocus'

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
}

const STEP_KEYS: MessageKey[] = ['wizard.stepStart', 'wizard.stepLayout', 'wizard.stepAgents']

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}

/**
 * The 3-step wizard: the composer's "Advanced..." (E8-FR-08). It opens on
 * `initialDraft` (default: the store's `wizardDraft`, folder, name, grid and
 * agent from the composer); `wizardPrefill` still seeds it when set.
 */
export function NewWorkspaceWizard({ initialDraft }: { initialDraft?: WizardInitialDraft | null } = {}) {
  const t = useT()
  const open = useAppStore((s) => s.wizardOpen && !s.composerOpen)
  const setWizardOpen = useAppStore((s) => s.setWizardOpen)
  const presets = useAppStore((s) => s.presets)
  const createWorkspaceFull = useAppStore((s) => s.createWorkspaceFull)
  const prefill = useAppStore((s) => s.wizardPrefill)
  const storeDraft = useAppStore((s) => s.wizardDraft)
  const seed = initialDraft !== undefined ? initialDraft : storeDraft

  const defaultPresetId = useMemo(
    () => presets.find((p) => p.type === 'shell')?.id ?? presets[0]?.id ?? '',
    [presets],
  )

  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<WizardDraft>({
    name: '',
    cwd: '',
    grid: 1,
    assignments: [defaultPresetId],
    setupId: '',
  })

  const dialogRef = useRef<HTMLDivElement>(null)
  /** Element focused before opening; focus returns there on cancel (E4-FR-31). */
  const prevFocus = useRef<HTMLElement | null>(null)
  const created = useRef(false)
  const [focusReq, setFocusReq] = useState(0)

  // Reset whenever the wizard opens (with the prefill, if any); on close,
  // hand focus back unless a workspace was created (its console takes it).
  useEffect(() => {
    if (open) {
      // Handed over by the composer, else whatever had the focus.
      const handed = takeFlowFocus()
      if (!prevFocus.current) prevFocus.current = handed ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      created.current = false
      setStep(0)
      if (seed) {
        const cell = presets.some((p) => p.id === seed.presetId) ? seed.presetId : defaultPresetId
        setDraft({
          name: seed.name || (seed.cwd ? basename(seed.cwd) : ''),
          cwd: seed.cwd,
          grid: seed.grid,
          assignments: Array.from({ length: seed.grid }, () => cell),
          setupId: seed.setupId,
        })
      } else {
        const cwd = prefill?.cwd ?? ''
        setDraft({ name: prefill?.name ?? (cwd ? basename(cwd) : ''), cwd, grid: 1, assignments: [defaultPresetId], setupId: '' })
      }
      setFocusReq((n) => n + 1)
      return
    }
    const prev = prevFocus.current
    prevFocus.current = null
    if (prev && !created.current && prev.isConnected) prev.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultPresetId, prefill, seed])

  // "Open in SnAgentsOS" never overwrites a folder being set up here (E4-FR-33).
  const flowOpen = useAppStore((s) => s.wizardOpen)
  useEffect(() => {
    if (open) setWizardDraftCwd(draft.cwd)
    else if (!flowOpen) setWizardDraftCwd(null)
  }, [open, flowOpen, draft.cwd])

  // Move focus inside once the reset draft rendered: the folder input on an
  // empty draft, the primary button when the folder came prefilled.
  useEffect(() => {
    if (!open || focusReq === 0) return
    const root = dialogRef.current
    if (!root) return
    const where = initialWizardFocus(draft.cwd)
    const el = root.querySelector<HTMLElement>(where === 'cwd' ? '[data-wizard-cwd]' : '[data-wizard-primary]')
    ;(el ?? root).focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq])

  // A step change can unmount the focused field (Enter in the folder input):
  // keep focus inside on the primary so the next Enter continues.
  useEffect(() => {
    const root = dialogRef.current
    if (!open || !root || root.contains(document.activeElement)) return
    root.querySelector<HTMLElement>('[data-wizard-primary]')?.focus()
  }, [open, step])

  // Escape closes. While open no key reaches the console behind: a keydown
  // aimed outside the dialog (a terminal that kept focus) is swallowed in the
  // capture phase and focus is pulled back in.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setWizardOpen(false)
    }
    const guard = (e: KeyboardEvent): void => {
      const root = dialogRef.current
      const target = e.target as Element | null
      // Only what sits behind the wizard: a terminal that kept focus, or the
      // body. An overlay opened above it (phone pairing prompt, update modal,
      // a toast) keeps its own keyboard and focus.
      const behind = !target || target === document.body || target === document.documentElement || !!target.closest?.('.xterm')
      if (!root || !behind || root.contains(target)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setWizardOpen(false)
        return
      }
      ;(root.querySelector<HTMLElement>('[data-wizard-cwd]') ?? root.querySelector<HTMLElement>('[data-wizard-primary]') ?? root).focus()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', guard, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', guard, true)
    }
  }, [open, setWizardOpen])

  if (!open) return null

  const update = (patch: Partial<WizardDraft>): void => {
    setDraft((prev) => {
      const next = { ...prev, ...patch }
      if (patch.grid !== undefined && patch.grid !== prev.grid) {
        const count = patch.grid as GridPreset
        const arr = prev.assignments.slice(0, count)
        while (arr.length < count) arr.push(defaultPresetId)
        next.assignments = arr
      }
      return next
    })
  }

  const hasCwd = draft.cwd.trim().length > 0
  const canAdvance = step === 0 ? hasCwd : true
  const isLast = step === 2

  const onCreate = (): void => {
    const panes = draft.assignments.map((pid) => {
      const preset = presets.find((p) => p.id === pid)
      if (!preset) {
        return { type: 'shell' as const, title: 'Shell', color: '#6366f1', icon: 'terminal' }
      }
      return {
        type: preset.type,
        presetId: preset.id,
        title: preset.name,
        color: preset.color,
        icon: preset.icon,
      }
    })
    created.current = true
    createWorkspaceFull({
      name: draft.name.trim() || basename(draft.cwd) || 'workspace',
      cwd: draft.cwd.trim(),
      grid: draft.grid,
      panes,
      setupId: draft.setupId || undefined,
    })
    setWizardOpen(false)
  }

  const onNext = (): void => setStep((s) => Math.min(2, s + 1))

  // Enter runs the step's primary, Ctrl+Enter creates with the defaults, Tab
  // stays inside (E4-FR-31). Native Enter targets are left alone.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Tab') {
      const root = dialogRef.current
      if (!root) return
      const items = focusables(root)
      e.preventDefault()
      const next = trapTabIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey)
      items[next]?.focus()
      return
    }
    const action = wizardKeyAction(
      { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
      e.target as HTMLElement,
      { canAdvance, hasCwd },
    )
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    if (action === 'create') onCreate()
    else if (action === 'advance') {
      if (isLast) onCreate()
      else onNext()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={(e) => { if (!isFromToast(e)) setWizardOpen(false) }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
        tabIndex={-1}
        data-wizard
        onKeyDown={onKeyDown}
        className="relative z-10 flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)] outline-none"
      >
        {/* Header + stepper */}
        <div className="shrink-0 border-b border-border px-6 pb-4 pt-5 text-center">
          <div className="mx-auto mb-4 flex max-w-md items-center justify-center">
            {STEP_KEYS.map((key, i) => (
              <div key={key} className="flex flex-1 items-center last:flex-none">
                <div className="flex flex-col items-center gap-1">
                  <div
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors',
                      i < step && 'bg-accent-violet text-white',
                      i === step && 'bg-accent-violet text-white',
                      i > step && 'border border-border bg-bg-primary text-text-secondary',
                    )}
                  >
                    {i < step ? <Check size={13} /> : i + 1}
                  </div>
                  <span
                    className={cn(
                      'text-[11px]',
                      i <= step ? 'text-text-primary' : 'text-text-secondary',
                    )}
                  >
                    {t(key)}
                  </span>
                </div>
                {i < STEP_KEYS.length - 1 && (
                  <div
                    className={cn(
                      'mx-2 h-px flex-1',
                      i < step ? 'bg-accent-violet' : 'bg-border',
                    )}
                  />
                )}
              </div>
            ))}
          </div>
          <h2 id="wizard-title" className="text-lg font-semibold text-text-primary">{t('wizard.title')}</h2>
          <p className="mt-0.5 text-sm text-text-secondary">{t('wizard.subtitle')}</p>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && <StepStart draft={draft} update={update} />}
          {step === 1 && <StepLayout draft={draft} update={update} />}
          {step === 2 && <StepAgents draft={draft} update={update} />}
        </div>

        <WizardFooter
          step={step}
          isLast={isLast}
          canAdvance={canAdvance}
          onBack={() => setStep((s) => Math.max(0, s - 1))}
          onNext={onNext}
          onCreate={onCreate}
          onCancel={() => setWizardOpen(false)}
        />
      </div>
    </div>
  )
}
