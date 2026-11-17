import { useSyncExternalStore } from 'react'
import { Mic, MicOff, Square } from 'lucide-react'
import { labOn } from '@shared/labs'
import { useAppStore } from '@/lib/store'
import { toggleHandsFree, useHandsFreeStore, type HandsFreePhase } from '@/lib/handsFree'
import { useT, type MessageKey } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'
import { isVoicePlaying, onVoicePlaying } from '@/lib/voicePlayer'

const LABEL: Record<HandsFreePhase, MessageKey> = {
  off: 'voice.pill.off',
  starting: 'voice.pill.starting',
  listening: 'voice.pill.listening',
  armed: 'voice.pill.armed',
  dictating: 'voice.pill.dictating',
  confirming: 'voice.pill.confirming',
  paused: 'voice.pill.paused',
}

/**
 * Sidebar row for hands-free voice (app 2.11.0, Labs voice): what it is doing
 * (off, listening, dictating to a console, speaking) and a click to turn it
 * on or off. Hidden with the Voice lab off.
 *
 * App 2.12.0: the voice can speak with hands-free off (narration
 * withoutHandsFree), so "speaking" follows the player itself, and a stop
 * button cuts what is being said (the next waiting item starts).
 */
export function HandsFreePill() {
  const t = useT()
  const lab = useAppStore((s) => labOn(s.settings, 'voice'))
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const phase = useHandsFreeStore((s) => s.phase)
  const playing = useSyncExternalStore(onVoicePlaying, isVoicePlaying)
  const target = useHandsFreeStore((s) => s.target)
  const title = useAppStore((s) => {
    if (!target) return ''
    for (const w of s.workspaces) for (const p of w.panes) if (p.id === target) return p.title
    return ''
  })
  if (!lab) return null
  const on = phase !== 'off'
  const label = playing ? t('voice.pill.speaking') : phase === 'dictating' ? t('voice.pill.dictatingTo', { name: title }) : t(LABEL[phase])
  const dot = playing ? 'bg-accent-violet' : !on ? 'bg-text-secondary/50' : phase === 'dictating' ? 'bg-state-action' : phase === 'paused' ? 'bg-sky-400' : 'bg-emerald-400'
  const Icon = on ? Mic : MicOff
  const stop = (
    <button type="button" onClick={() => void window.snApi?.voice?.cmd({ kind: 'stop' }).catch(() => undefined)} data-voice-stop aria-label={t('voice.pill.stop')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary">
      <Square size={12} />
    </button>
  )

  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border px-2 py-3">
        <Tooltip label={`${t('voice.pill.title')} · ${label}`} side="right">
          <button onClick={toggleHandsFree} data-hands-free-pill={phase} aria-pressed={on} className="relative flex h-8 w-8 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary">
            <Icon size={16} />
            <span className={cn('absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-bg-secondary', dot)} />
          </button>
        </Tooltip>
        {playing && (
          <Tooltip label={t('voice.pill.stop')} side="right">
            {stop}
          </Tooltip>
        )}
      </div>
    )
  }
  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-2.5 py-2.5">
      <button onClick={toggleHandsFree} data-hands-free-pill={phase} aria-pressed={on} className="flex min-w-0 flex-1 items-center gap-2 rounded-btn px-1.5 py-1 text-text-secondary transition-colors hover:bg-card hover:text-text-primary">
        <Icon size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left text-xs">{label}</span>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dot, (on || playing) && phase !== 'paused' && 'animate-pulse')} />
      </button>
      {playing && stop}
    </div>
  )
}
