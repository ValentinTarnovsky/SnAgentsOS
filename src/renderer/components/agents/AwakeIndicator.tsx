import { useEffect, useState } from 'react'
import { Coffee, Settings } from 'lucide-react'
import type { AwakeMode } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { usePowerStore } from '@/lib/powerStore'
import { awakeIndicatorVisible, awakeTooltip } from '@/lib/awake'
import { ContextMenu } from '@/components/ui/ContextMenu'
import { Tooltip } from '@/components/ui/Tooltip'
import { useT, type MessageKey } from '@/i18n'

const MODES: Array<{ mode: AwakeMode; key: MessageKey }> = [
  { mode: 'auto', key: 'awake.mode.auto' },
  { mode: 'always', key: 'awake.mode.always' },
  { mode: 'never', key: 'awake.mode.never' },
]

/**
 * Title bar coffee icon (E5-FR-24): visible while the PC is kept awake, or in
 * `always` mode. The tooltip says why (or the grace countdown); a click opens
 * the Auto / Always / Never radios plus a link to the agent settings.
 */
export function AwakeIndicator() {
  const t = useT()
  const state = usePowerStore((s) => s.state)
  const mode = useAppStore((s) => s.settings.awakeMode)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettings = useAppStore((s) => s.openSettings)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const releaseAt = state?.releaseAt

  // Tick the "releases in 1:45" countdown only during the grace.
  useEffect(() => {
    if (releaseAt === undefined) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [releaseAt])

  if (!state || !awakeIndicatorVisible(state, mode)) return null
  const tip = awakeTooltip(state, mode, now)
  const label = t(tip.key, tip.vars)
  const current = state.mode ?? mode

  return (
    <>
      <Tooltip label={label} side="bottom">
        <button
          type="button"
          id="awake-indicator"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom + 4 })
          }}
          className="flex h-9 w-9 items-center justify-center text-accent-violet transition-colors hover:bg-card"
        >
          <Coffee size={15} />
        </button>
      </Tooltip>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('awake.menu')}
          onClose={() => setMenu(null)}
          items={[
            ...MODES.map(({ mode: m, key }) => ({
              label: t(key),
              checked: current === m,
              onClick: () => updateSettings({ awakeMode: m }),
            })),
            {
              label: t('awake.agentSettings'),
              icon: Settings,
              separated: true,
              onClick: () => openSettings('agents'),
            },
          ]}
        />
      )}
    </>
  )
}
