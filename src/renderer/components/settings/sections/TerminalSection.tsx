import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { SettingRow, inputCls } from '../ui'
import { cn } from '@/lib/cn'

export function TerminalSection() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SettingRow title={t('settings.shellWin')}>
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
        </SettingRow>
        <SettingRow title={t('settings.shellMac')}>
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
        </SettingRow>
        <SettingRow title={t('settings.shellLinux')}>
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
        </SettingRow>
      </div>

      <SettingRow title={t('settings.fontFamily')}>
        <input
          className={cn(inputCls, 'font-mono')}
          value={settings.fontFamily}
          onChange={(e) => updateSettings({ fontFamily: e.target.value })}
        />
      </SettingRow>

      <div className="grid grid-cols-2 gap-4">
        <SettingRow title={t('settings.fontSize')}>
          <input
            type="number"
            min={8}
            max={32}
            className={inputCls}
            value={settings.fontSize}
            onChange={(e) => updateSettings({ fontSize: Number(e.target.value) || 13 })}
          />
        </SettingRow>
        <SettingRow title={t('settings.scrollback')}>
          <input
            type="number"
            min={500}
            max={100000}
            step={500}
            className={inputCls}
            value={settings.scrollback}
            onChange={(e) => updateSettings({ scrollback: Number(e.target.value) || 5000 })}
          />
        </SettingRow>
      </div>
    </div>
  )
}
