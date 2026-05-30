import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { AgentPreset, PaneType } from '@shared/types'
import { ICON_NAMES, iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'

const ACCENT_SWATCHES = ['#6366f1', '#8b5cf6', '#60a5fa', '#d97757', '#10a37f', '#22c55e', '#f59e0b', '#ef4444']
const TYPES: PaneType[] = ['shell', 'claude', 'codex', 'custom']

const inputCls =
  'h-9 w-full rounded-btn border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet focus:ring-2 focus:ring-[rgba(99,102,241,0.25)]'
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary'

function envToText(env?: Record<string, string>): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

export function PresetEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: AgentPreset
  onSave: (preset: AgentPreset) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [type, setType] = useState<PaneType>(initial.type)
  const [command, setCommand] = useState(initial.command)
  const [args, setArgs] = useState(initial.args.join(' '))
  const [envText, setEnvText] = useState(envToText(initial.env))
  const [defaultCwd, setDefaultCwd] = useState(initial.defaultCwd ?? '')
  const [color, setColor] = useState(initial.color)
  const [icon, setIcon] = useState(initial.icon)

  const pickFolder = async (): Promise<void> => {
    const dir = await window.snApi.dialog.openDirectory()
    if (dir) setDefaultCwd(dir)
  }

  const save = (): void => {
    onSave({
      id: initial.id,
      name: name.trim() || 'Preset',
      type,
      command: command.trim(),
      args: args.trim() ? args.trim().split(/\s+/) : [],
      env: parseEnv(envText),
      color,
      icon,
      defaultCwd: defaultCwd.trim() || undefined,
    })
  }

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Nombre</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Tipo</label>
          <select
            className={inputCls}
            value={type}
            onChange={(e) => setType(e.target.value as PaneType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t} className="bg-card">
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls}>
          Comando {type === 'shell' && <span className="text-text-secondary/60">(vacío = shell por defecto)</span>}
        </label>
        <input
          className={cn(inputCls, 'font-mono')}
          value={command}
          placeholder={type === 'shell' ? 'powershell.exe / pwsh / wsl…' : 'claude'}
          onChange={(e) => setCommand(e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls}>Argumentos (separados por espacio)</label>
        <input
          className={cn(inputCls, 'font-mono')}
          value={args}
          placeholder="--model gpt-5"
          onChange={(e) => setArgs(e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls}>Variables de entorno (una por línea, KEY=VALUE)</label>
        <textarea
          className={cn(inputCls, 'h-20 resize-none py-2 font-mono')}
          value={envText}
          placeholder={'NODE_ENV=production'}
          onChange={(e) => setEnvText(e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls}>Directorio por defecto (opcional)</label>
        <div className="flex gap-2">
          <input
            className={cn(inputCls, 'font-mono')}
            value={defaultCwd}
            placeholder="usa el cwd del workspace"
            onChange={(e) => setDefaultCwd(e.target.value)}
          />
          <button
            onClick={pickFolder}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-btn border border-border bg-bg-secondary px-3 text-sm text-text-primary hover:border-accent-violet/40"
          >
            <FolderOpen size={15} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Color</label>
          <div className="flex flex-wrap gap-1.5">
            {ACCENT_SWATCHES.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={cn(
                  'h-6 w-6 rounded-full border-2 transition-transform',
                  color === c ? 'scale-110 border-text-primary' : 'border-transparent',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div>
          <label className={labelCls}>Ícono</label>
          <div className="flex flex-wrap gap-1.5">
            {ICON_NAMES.map((n) => {
              const Icon = iconFor(n)
              return (
                <button
                  key={n}
                  onClick={() => setIcon(n)}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-btn border transition-colors',
                    icon === n
                      ? 'border-accent-violet text-text-primary'
                      : 'border-border text-text-secondary hover:text-text-primary',
                  )}
                >
                  <Icon size={15} />
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-btn border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          Cancelar
        </button>
        <button
          onClick={save}
          className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          Guardar
        </button>
      </div>
    </div>
  )
}
