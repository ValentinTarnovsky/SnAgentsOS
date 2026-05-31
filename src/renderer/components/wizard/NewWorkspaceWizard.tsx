import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import type { GridPreset } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { StepStart } from './StepStart'
import { StepLayout } from './StepLayout'
import { StepAgents } from './StepAgents'
import { WizardFooter } from './WizardFooter'
import type { WizardDraft } from './types'

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
}

const STEP_KEYS: MessageKey[] = ['wizard.stepStart', 'wizard.stepLayout', 'wizard.stepAgents']

export function NewWorkspaceWizard() {
  const t = useT()
  const open = useAppStore((s) => s.wizardOpen)
  const setWizardOpen = useAppStore((s) => s.setWizardOpen)
  const presets = useAppStore((s) => s.presets)
  const createWorkspaceFull = useAppStore((s) => s.createWorkspaceFull)

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

  // Reset whenever the wizard opens.
  useEffect(() => {
    if (open) {
      setStep(0)
      setDraft({ name: '', cwd: '', grid: 1, assignments: [defaultPresetId], setupId: '' })
    }
  }, [open, defaultPresetId])

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setWizardOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  const canAdvance = step === 0 ? draft.cwd.trim().length > 0 : true
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
    createWorkspaceFull({
      name: draft.name.trim() || basename(draft.cwd) || 'workspace',
      cwd: draft.cwd.trim(),
      grid: draft.grid,
      panes,
      setupId: draft.setupId || undefined,
    })
    setWizardOpen(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={() => setWizardOpen(false)} />
      <div className="relative z-10 flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
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
          <h2 className="text-lg font-semibold text-text-primary">{t('wizard.title')}</h2>
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
          onNext={() => setStep((s) => Math.min(2, s + 1))}
          onCreate={onCreate}
          onCancel={() => setWizardOpen(false)}
        />
      </div>
    </div>
  )
}
