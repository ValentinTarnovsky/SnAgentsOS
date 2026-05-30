import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { AgentPreset, AccentName } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { iconFor } from '@/lib/icons'
import { Modal } from '@/components/common/Modal'
import { PresetEditor } from './PresetEditor'
import { cn } from '@/lib/cn'

type Tab = 'presets' | 'prefs'

const inputCls =
  'h-9 w-full rounded-btn border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet focus:ring-2 focus:ring-[rgba(99,102,241,0.25)]'
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary'

const ACCENTS: { name: AccentName; hex: string }[] = [
  { name: 'violet', hex: '#6366f1' },
  { name: 'purple', hex: '#8b5cf6' },
  { name: 'blue', hex: '#60a5fa' },
]

export function SettingsModal() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const presets = useAppStore((s) => s.presets)
  const savePreset = useAppStore((s) => s.savePreset)
  const deletePreset = useAppStore((s) => s.deletePreset)
  const newPresetId = useAppStore((s) => s.newPresetId)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [tab, setTab] = useState<Tab>('presets')
  const [editing, setEditing] = useState<AgentPreset | null>(null)

  const startNew = (): void =>
    setEditing({
      id: newPresetId(),
      name: '',
      type: 'custom',
      command: '',
      args: [],
      color: '#6366f1',
      icon: 'terminal',
    })

  const close = (): void => {
    setEditing(null)
    setOpen(false)
  }

  return (
    <Modal open={open} onClose={close} title="Ajustes">
      {editing ? (
        <PresetEditor
          initial={editing}
          onSave={(p) => {
            savePreset(p)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="flex gap-1 border-b border-border px-3 pt-3">
            <TabButton active={tab === 'presets'} onClick={() => setTab('presets')}>
              Presets de agente
            </TabButton>
            <TabButton active={tab === 'prefs'} onClick={() => setTab('prefs')}>
              Preferencias
            </TabButton>
          </div>

          {tab === 'presets' ? (
            <div className="space-y-2 p-5">
              {presets.map((preset) => {
                const Icon = iconFor(preset.icon)
                return (
                  <div
                    key={preset.id}
                    className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
                  >
                    <Icon size={18} style={{ color: preset.color }} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-text-primary">{preset.name}</span>
                        <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-text-secondary">
                          {preset.type}
                        </span>
                      </div>
                      {preset.command && (
                        <span className="block truncate font-mono text-[11px] text-text-secondary">
                          {[preset.command, ...preset.args].join(' ')}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => setEditing(preset)}
                      className="rounded p-1.5 text-text-secondary hover:text-text-primary"
                      title="Editar"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => deletePreset(preset.id)}
                      className="rounded p-1.5 text-text-secondary hover:text-red-400"
                      title="Eliminar"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )
              })}

              <button
                onClick={startNew}
                className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
              >
                <Plus size={16} />
                Nuevo preset
              </button>
            </div>
          ) : (
            <div className="space-y-5 p-5">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>Shell Windows</label>
                  <input
                    className={cn(inputCls, 'font-mono')}
                    placeholder="powershell.exe"
                    value={settings.defaultShell.win32 ?? ''}
                    onChange={(e) =>
                      updateSettings({
                        defaultShell: { ...settings.defaultShell, win32: e.target.value || undefined },
                      })
                    }
                  />
                </div>
                <div>
                  <label className={labelCls}>Shell macOS</label>
                  <input
                    className={cn(inputCls, 'font-mono')}
                    placeholder="/bin/zsh"
                    value={settings.defaultShell.darwin ?? ''}
                    onChange={(e) =>
                      updateSettings({
                        defaultShell: { ...settings.defaultShell, darwin: e.target.value || undefined },
                      })
                    }
                  />
                </div>
                <div>
                  <label className={labelCls}>Shell Linux</label>
                  <input
                    className={cn(inputCls, 'font-mono')}
                    placeholder="/bin/bash"
                    value={settings.defaultShell.linux ?? ''}
                    onChange={(e) =>
                      updateSettings({
                        defaultShell: { ...settings.defaultShell, linux: e.target.value || undefined },
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Tamaño de fuente (terminal)</label>
                  <input
                    type="number"
                    min={8}
                    max={32}
                    className={inputCls}
                    value={settings.fontSize}
                    onChange={(e) => updateSettings({ fontSize: Number(e.target.value) || 13 })}
                  />
                </div>
                <div>
                  <label className={labelCls}>Scrollback (líneas)</label>
                  <input
                    type="number"
                    min={500}
                    max={100000}
                    step={500}
                    className={inputCls}
                    value={settings.scrollback}
                    onChange={(e) => updateSettings({ scrollback: Number(e.target.value) || 5000 })}
                  />
                </div>
              </div>

              <div>
                <label className={labelCls}>Acento</label>
                <div className="flex gap-2">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.name}
                      onClick={() => updateSettings({ accent: a.name })}
                      className={cn(
                        'flex items-center gap-2 rounded-btn border px-3 py-1.5 text-sm capitalize',
                        settings.accent === a.name
                          ? 'border-text-primary text-text-primary'
                          : 'border-border text-text-secondary hover:text-text-primary',
                      )}
                    >
                      <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: a.hex }} />
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Toggle
                  checked={settings.restoreLastWorkspace}
                  onChange={(v) => updateSettings({ restoreLastWorkspace: v })}
                  label="Restaurar el último workspace al abrir"
                />
                <Toggle
                  checked={settings.confirmCloseRunning}
                  onChange={(v) => updateSettings({ confirmCloseRunning: v })}
                  label="Confirmar al cerrar con procesos activos"
                />
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-t-btn px-3 py-2 text-sm transition-colors',
        active
          ? 'border-b-2 border-accent-violet text-text-primary'
          : 'text-text-secondary hover:text-text-primary',
      )}
    >
      {children}
    </button>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 text-left text-sm text-text-primary"
    >
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent-violet' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </span>
      {label}
    </button>
  )
}
