import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Bot, Pencil, Plus, Trash2, Type } from 'lucide-react'
import type { AgentPreset, QuickCommand, Workspace } from '@shared/types'
import { QUICK_COMMANDS_MAX, QUICK_COMMAND_NAME_MAX, QUICK_COMMAND_TEXT_MAX } from '@shared/quickCommands'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { inputCls, labelCls } from '../ui'
import { cn } from '@/lib/cn'

/** The workspace's repo-imported command ids (E8-FR-25), when the field exists. */
function repoIds(ws: Workspace | undefined): string[] {
  const ids = (ws as (Workspace & { repoConfig?: { quickCommandIds?: unknown } }) | undefined)?.repoConfig?.quickCommandIds
  return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : []
}

/** Default preset of a new agent command: the configured one, else the first claude preset. */
export function defaultAgentPreset(presets: AgentPreset[], configured: string | undefined): string {
  if (configured && presets.some((p) => p.id === configured)) return configured
  return (presets.find((p) => p.type === 'claude') ?? presets[0])?.id ?? ''
}

/**
 * True when the editor may save: a label and a text (or prompt), a preset for
 * an agent, and room for a new command (the 101st cannot be created).
 */
export function canSaveQuickCommand(draft: QuickCommand, isNew: boolean, count: number): boolean {
  if (!draft.name.trim() || !draft.text.trim()) return false
  if (draft.action === 'agent' && !draft.presetId) return false
  return !(isNew && count >= QUICK_COMMANDS_MAX)
}

/** Settings > Quick Commands (E8-FR-03): list, order, scope and the editor. */
export function QuickCommandsSection() {
  const t = useT()
  const commands = useAppStore((s) => s.quickCommands)
  const workspaces = useAppStore((s) => s.workspaces)
  const presets = useAppStore((s) => s.presets)
  const defaultPresetId = useAppStore((s) => s.settings.automation?.defaultAgentPresetId)
  const saveCommand = useAppStore((s) => s.saveQuickCommand)
  const deleteCommand = useAppStore((s) => s.deleteQuickCommand)
  const moveCommand = useAppStore((s) => s.moveQuickCommand)
  const newId = useAppStore((s) => s.newQuickCommandId)
  const editReq = useAppStore((s) => s.quickEdit)
  const setEditReq = useAppStore((s) => s.setQuickEdit)
  const [editing, setEditing] = useState<{ cmd: QuickCommand; isNew: boolean } | null>(null)
  const atLimit = commands.length >= QUICK_COMMANDS_MAX

  // A run whose preset is gone opens its command here (E8-FR-05); the
  // popover's "Create" opens a new one scoped to the active workspace.
  useEffect(() => {
    if (!editReq) return
    if ('id' in editReq) {
      const cmd = useAppStore.getState().quickCommands.find((c) => c.id === editReq.id)
      if (cmd) setEditing({ cmd, isNew: false })
    } else if (useAppStore.getState().quickCommands.length < QUICK_COMMANDS_MAX) {
      const scope = editReq.newScope ? { workspaceId: editReq.newScope } : {}
      setEditing({ cmd: { id: newId(), name: '', text: '', action: 'send', enter: false, ...scope }, isNew: true })
    }
    setEditReq(null)
  }, [editReq, setEditReq, newId])

  if (editing) {
    return (
      <QuickCommandEditor
        initial={editing.cmd}
        isNew={editing.isNew}
        count={commands.length}
        workspaces={workspaces}
        presets={presets}
        defaultPresetId={defaultAgentPreset(presets, defaultPresetId)}
        onSave={(cmd) => {
          if (saveCommand(cmd)) setEditing(null)
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  const scopeLabel = (cmd: QuickCommand): { text: string; missing: boolean } => {
    if (!cmd.workspaceId) return { text: t('quick.scope.global'), missing: false }
    const ws = workspaces.find((w) => w.id === cmd.workspaceId)
    return ws ? { text: ws.name, missing: false } : { text: t('quick.scope.missing'), missing: true }
  }

  return (
    <div className="space-y-2" data-quick-section>
      <p className="text-xs text-text-secondary">{t('quick.hint')}</p>

      {commands.map((cmd, i) => {
        const scope = scopeLabel(cmd)
        const repo = !!cmd.workspaceId && repoIds(workspaces.find((w) => w.id === cmd.workspaceId)).includes(cmd.id)
        const Icon = cmd.action === 'agent' ? Bot : Type
        return (
          <div
            key={cmd.id}
            data-quick-row={cmd.id}
            className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
          >
            <Icon size={15} className="shrink-0 text-text-secondary" aria-label={t(cmd.action === 'agent' ? 'quick.action.agent' : 'quick.action.send')} />
            <div className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm text-text-primary">{cmd.name}</span>
                <span
                  data-quick-scope
                  className={cn(
                    'shrink-0 rounded border px-1 text-[10px]',
                    scope.missing ? 'border-amber-400/40 text-amber-400' : 'border-border text-text-secondary',
                  )}
                >
                  {scope.text}
                </span>
                {repo && <span className="shrink-0 rounded border border-border px-1 text-[10px] text-text-secondary">{t('quick.repo')}</span>}
              </span>
              <span className="block truncate font-mono text-[11px] text-text-secondary">{cmd.text}</span>
            </div>
            <button
              onClick={() => moveCommand(cmd.id, -1)}
              disabled={i === 0}
              className="rounded p-1.5 text-text-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-30"
              title={t('quick.moveUp')}
              aria-label={t('quick.moveUp')}
            >
              <ArrowUp size={14} />
            </button>
            <button
              onClick={() => moveCommand(cmd.id, 1)}
              disabled={i === commands.length - 1}
              className="rounded p-1.5 text-text-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-30"
              title={t('quick.moveDown')}
              aria-label={t('quick.moveDown')}
            >
              <ArrowDown size={14} />
            </button>
            <button
              onClick={() => setEditing({ cmd, isNew: false })}
              className="rounded p-1.5 text-text-secondary hover:text-text-primary"
              title={t('quick.edit')}
              aria-label={t('quick.edit')}
            >
              <Pencil size={15} />
            </button>
            <button
              onClick={() => deleteCommand(cmd.id)}
              className="rounded p-1.5 text-text-secondary hover:text-red-400"
              title={t('ctx.delete')}
              aria-label={t('ctx.delete')}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )
      })}

      {atLimit && <p className="text-xs text-amber-400">{t('quick.limit')}</p>}
      <button
        disabled={atLimit}
        data-quick-new
        onClick={() => setEditing({ cmd: { id: newId(), name: '', text: '', action: 'send', enter: false }, isNew: true })}
        className="disabled:pointer-events-none disabled:opacity-50 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
      >
        <Plus size={16} />
        {t('quick.new')}
      </button>
    </div>
  )
}

function QuickCommandEditor({
  initial,
  isNew,
  count,
  workspaces,
  presets,
  defaultPresetId,
  onSave,
  onCancel,
}: {
  initial: QuickCommand
  isNew: boolean
  count: number
  workspaces: Workspace[]
  presets: AgentPreset[]
  defaultPresetId: string
  onSave: (cmd: QuickCommand) => void
  onCancel: () => void
}) {
  const t = useT()
  const [name, setName] = useState(initial.name)
  const [scope, setScope] = useState(initial.workspaceId ?? '')
  const [action, setAction] = useState<QuickCommand['action']>(initial.action)
  const [text, setText] = useState(initial.text)
  const [enter, setEnter] = useState(initial.action === 'send' ? initial.enter : false)
  const [presetId, setPresetId] = useState(initial.presetId && presets.some((p) => p.id === initial.presetId) ? initial.presetId : defaultPresetId)

  const draft: QuickCommand = {
    id: initial.id,
    name: name.trim(),
    text,
    action,
    enter: action === 'agent' ? true : enter,
    ...(scope ? { workspaceId: scope } : {}),
    ...(action === 'agent' && presetId ? { presetId } : {}),
  }
  const canSave = canSaveQuickCommand(draft, isNew, count)
  // A scope pointing at a deleted workspace stays selectable until changed.
  const missingScope = !!initial.workspaceId && !workspaces.some((w) => w.id === initial.workspaceId)
  const segBtn = (active: boolean): string =>
    cn('flex-1 rounded-btn px-3 py-1.5 text-xs transition-colors', active ? 'bg-accent-violet text-white' : 'text-text-secondary hover:text-text-primary')

  return (
    <div className="space-y-4" data-quick-editor>
      <div>
        <label className={labelCls}>{t('quick.label')}</label>
        <input
          className={inputCls}
          value={name}
          data-quick-name
          maxLength={QUICK_COMMAND_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>
      <div>
        <label className={labelCls}>{t('quick.scope')}</label>
        <select className={inputCls} value={scope} data-quick-scope-select onChange={(e) => setScope(e.target.value)}>
          <option value="">{t('quick.scope.global')}</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          {missingScope && <option value={initial.workspaceId}>{t('quick.scope.missing')}</option>}
        </select>
      </div>
      <div>
        <label className={labelCls}>{t('quick.action')}</label>
        <div className="flex gap-1 rounded-btn border border-border bg-bg-primary p-1" role="radiogroup">
          <button type="button" role="radio" aria-checked={action === 'send'} data-quick-action="send" className={segBtn(action === 'send')} onClick={() => setAction('send')}>
            {t('quick.action.send')}
          </button>
          <button type="button" role="radio" aria-checked={action === 'agent'} data-quick-action="agent" className={segBtn(action === 'agent')} onClick={() => setAction('agent')}>
            {t('quick.action.agent')}
          </button>
        </div>
      </div>
      {action === 'agent' && (
        <div>
          <label className={labelCls}>{t('quick.preset')}</label>
          <select className={inputCls} value={presetId} data-quick-preset onChange={(e) => setPresetId(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className={labelCls}>{t(action === 'agent' ? 'quick.prompt' : 'quick.text')}</label>
        <textarea
          className={cn(inputCls, 'h-40 resize-none py-2 font-mono')}
          value={text}
          data-quick-text
          maxLength={QUICK_COMMAND_TEXT_MAX}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {action === 'send' && (
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={enter} data-quick-enter onChange={(e) => setEnter(e.target.checked)} />
          {t('quick.enter')}
        </label>
      )}
      {isNew && count >= QUICK_COMMANDS_MAX && <p className="text-xs text-amber-400">{t('quick.limit')}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-btn border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          {t('common.cancel')}
        </button>
        <button
          disabled={!canSave}
          data-quick-save
          onClick={() => onSave(draft)}
          className="disabled:pointer-events-none disabled:opacity-50 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}
