import { useState } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ConnectionProfile, SetupStep } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { inputCls, labelCls } from '../ui'
import { cn } from '@/lib/cn'

export function ConnectionsSection() {
  const t = useT()
  const connections = useAppStore((s) => s.connections)
  const saveConnection = useAppStore((s) => s.saveConnection)
  const deleteConnection = useAppStore((s) => s.deleteConnection)
  const newConnectionId = useAppStore((s) => s.newConnectionId)
  const [editing, setEditing] = useState<ConnectionProfile | null>(null)

  if (editing) {
    return (
      <ConnectionEditor
        initial={editing}
        onSave={(c) => {
          saveConnection(c)
          setEditing(null)
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-secondary">{t('connections.hint')}</p>

      {connections.map((c) => (
        <div
          key={c.id}
          className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm text-text-primary">{c.name}</span>
            <span className="block truncate font-mono text-[11px] text-text-secondary">
              {t('connections.stepCount', { n: c.steps.length })}
            </span>
          </div>
          <button
            onClick={() => setEditing(c)}
            className="rounded p-1.5 text-text-secondary hover:text-text-primary"
            title={t('settings.edit')}
          >
            <Pencil size={15} />
          </button>
          <button
            onClick={() => deleteConnection(c.id)}
            className="rounded p-1.5 text-text-secondary hover:text-red-400"
            title={t('ctx.delete')}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}

      <button
        onClick={() => setEditing({ id: newConnectionId(), name: '', steps: [{ send: '' }] })}
        className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
      >
        <Plus size={16} />
        {t('connections.new')}
      </button>
    </div>
  )
}

function ConnectionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: ConnectionProfile
  onSave: (connection: ConnectionProfile) => void
  onCancel: () => void
}) {
  const t = useT()
  const [name, setName] = useState(initial.name)
  const [steps, setSteps] = useState<SetupStep[]>(
    initial.steps.length ? initial.steps : [{ send: '' }],
  )

  const patchStep = (i: number, patch: Partial<SetupStep>): void =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const removeStep = (i: number): void => setSteps((prev) => prev.filter((_, idx) => idx !== i))
  const addStep = (): void => setSteps((prev) => [...prev, { send: '' }])
  const moveStep = (i: number, dir: -1 | 1): void =>
    setSteps((prev) => {
      const to = i + dir
      if (to < 0 || to >= prev.length) return prev
      const next = prev.slice()
      ;[next[i], next[to]] = [next[to], next[i]]
      return next
    })

  const save = (): void => {
    const clean: SetupStep[] = steps
      .map((s) => ({
        send: s.send,
        waitFor: s.waitFor?.trim() ? s.waitFor.trim() : undefined,
        timeoutMs: s.timeoutMs && s.timeoutMs > 0 ? s.timeoutMs : undefined,
        delayMs: s.delayMs && s.delayMs > 0 ? s.delayMs : undefined,
        secret: s.secret || undefined,
        noEnter: s.noEnter || undefined,
      }))
      // Drop fully empty steps (nothing to send, wait for, or pause on).
      .filter((s) => s.send.trim() || s.waitFor || s.delayMs)
    onSave({ id: initial.id, name: name.trim() || 'Connection', steps: clean })
  }

  return (
    <div className="space-y-4">
      <div>
        <label className={labelCls}>{t('connections.name')}</label>
        <input
          className={inputCls}
          value={name}
          placeholder={t('connections.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls}>{t('connections.steps')}</label>
        <div className="space-y-2">
          {steps.map((step, i) => (
            <StepRow
              key={i}
              step={step}
              index={i}
              total={steps.length}
              onPatch={(p) => patchStep(i, p)}
              onRemove={() => removeStep(i)}
              onMove={(d) => moveStep(i, d)}
            />
          ))}
        </div>
        <button
          onClick={addStep}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-btn border border-dashed border-border py-2 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
        >
          <Plus size={15} />
          {t('connections.addStep')}
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-text-secondary">{t('connections.secretWarning')}</p>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-btn border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={save}
          className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}

function StepRow({
  step,
  index,
  total,
  onPatch,
  onRemove,
  onMove,
}: {
  step: SetupStep
  index: number
  total: number
  onPatch: (patch: Partial<SetupStep>) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const t = useT()
  const [reveal, setReveal] = useState(false)
  const [adv, setAdv] = useState(false)

  return (
    <div className="space-y-2 rounded-btn border border-border bg-bg-primary p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-card text-[10px] text-text-secondary">
          {index + 1}
        </span>
        <span className="flex-1 text-xs font-medium text-text-secondary">{t('connections.step')}</span>
        <button
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className="rounded p-1 text-text-secondary transition-colors hover:text-text-primary disabled:opacity-30"
          title={t('connections.moveUp')}
        >
          <ArrowUp size={14} />
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          className="rounded p-1 text-text-secondary transition-colors hover:text-text-primary disabled:opacity-30"
          title={t('connections.moveDown')}
        >
          <ArrowDown size={14} />
        </button>
        <button
          onClick={onRemove}
          className="rounded p-1 text-text-secondary transition-colors hover:text-red-400"
          title={t('ctx.delete')}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div>
        <label className="mb-1 block text-[11px] text-text-secondary">{t('connections.waitFor')}</label>
        <input
          className={cn(inputCls, 'font-mono')}
          value={step.waitFor ?? ''}
          placeholder={t('connections.waitForPlaceholder')}
          onChange={(e) => onPatch({ waitFor: e.target.value })}
        />
      </div>

      <div>
        <label className="mb-1 block text-[11px] text-text-secondary">{t('connections.send')}</label>
        <div className="flex gap-2">
          <input
            type={step.secret && !reveal ? 'password' : 'text'}
            className={cn(inputCls, 'font-mono')}
            value={step.send}
            placeholder={t('connections.sendPlaceholder')}
            onChange={(e) => onPatch({ send: e.target.value })}
          />
          {step.secret && (
            <button
              onClick={() => setReveal((r) => !r)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn border border-border bg-bg-secondary text-text-secondary hover:text-text-primary"
              title={reveal ? t('connections.hide') : t('connections.reveal')}
            >
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={!!step.secret}
            onChange={(e) => onPatch({ secret: e.target.checked })}
          />
          {t('connections.secret')}
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={!!step.noEnter}
            onChange={(e) => onPatch({ noEnter: e.target.checked })}
          />
          {t('connections.noEnter')}
        </label>
        <button
          onClick={() => setAdv((a) => !a)}
          className="ml-auto text-[11px] text-accent-violet hover:underline"
        >
          {adv ? t('connections.lessOptions') : t('connections.moreOptions')}
        </button>
      </div>

      {adv && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[11px] text-text-secondary">{t('connections.delay')}</label>
            <input
              type="number"
              min={0}
              className={inputCls}
              value={step.delayMs ?? ''}
              placeholder="0"
              onChange={(e) => onPatch({ delayMs: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-secondary">{t('connections.timeout')}</label>
            <input
              type="number"
              min={0}
              className={inputCls}
              value={step.timeoutMs ?? ''}
              placeholder="15000"
              onChange={(e) =>
                onPatch({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </div>
        </div>
      )}
    </div>
  )
}
