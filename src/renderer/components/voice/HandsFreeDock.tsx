import { useEffect } from 'react'
import { CornerDownLeft, Mic, Type, X } from 'lucide-react'
import { labOn } from '@shared/labs'
import { useAppStore } from '@/lib/store'
import { deliver, discardHeld, sendHeld, useHandsFreeStore } from '@/lib/handsFree'
import { wireVoicePlayer } from '@/lib/voicePlayer'
import { toast } from '@/lib/toast'
import { useT, type MessageKey } from '@/i18n'

const NOTICE: Record<string, MessageKey> = {
  elevenCap: 'voice.notice.elevenCap',
  elevenFailed: 'voice.notice.elevenFailed',
  engineMissing: 'voice.notice.engineMissing',
  engineFailed: 'voice.notice.engineFailed',
}

/**
 * Hands-free voice (app 2.11.0, Labs voice): the dictation buffer while the
 * user dictates to a console ("Dictando a X: ..."), and a held dictation with
 * Enviar / Insertar / Descartar. Nothing reaches the console until a send or
 * an insert. Also wires the voice player and main's notices once the lab is on.
 */
export function HandsFreeDock() {
  const t = useT()
  const lab = useAppStore((s) => labOn(s.settings, 'voice'))
  const phase = useHandsFreeStore((s) => s.phase)
  const buffer = useHandsFreeStore((s) => s.buffer)
  const target = useHandsFreeStore((s) => s.target)
  const held = useHandsFreeStore((s) => s.held)
  const titleOf = (id: string | null | undefined): string => {
    if (!id) return ''
    for (const w of useAppStore.getState().workspaces) for (const p of w.panes) if (p.id === id) return p.title
    return ''
  }

  useEffect(() => {
    if (!lab) return
    wireVoicePlayer()
    const off = window.snApi?.voice?.onEvent((e) => {
      if (e.t === 'notice' && NOTICE[e.code]) toast.warning(t(NOTICE[e.code]), { dedupeKey: `voice:${e.code}` })
    })
    return () => off?.()
  }, [lab, t])

  if (!lab) return null
  const dictating = phase === 'dictating' && !!target
  if (!dictating && !held) return null
  const text = dictating ? buffer : held?.text ?? ''
  const name = titleOf(dictating ? target : held?.paneId)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4" data-hands-free-dock={dictating ? 'dictating' : 'held'}>
      <div className="pointer-events-auto w-full max-w-xl rounded-card border border-border bg-bg-secondary/95 p-3 shadow-lg backdrop-blur">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs text-text-secondary">
          <Mic size={13} className={dictating ? 'text-state-action' : ''} />
          <span className="truncate">{dictating ? t('voice.dock.dictating', { name }) : t('voice.dock.held', { name })}</span>
        </div>
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm text-text-primary" data-hands-free-buffer>
          {text || <span className="text-text-secondary">{t('voice.dock.empty')}</span>}
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="inline-flex items-center gap-1 rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary hover:bg-card" onClick={() => (dictating ? useHandsFreeStore.setState({ buffer: '', phase: 'listening' }) : discardHeld())}>
            <X size={13} /> {t('voice.dock.discard')}
          </button>
          <button type="button" disabled={!text} className="inline-flex items-center gap-1 rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary hover:bg-card disabled:opacity-50" onClick={() => (dictating ? void deliver(false) : sendHeld(false))}>
            <Type size={13} /> {t('voice.dock.insert')}
          </button>
          <button type="button" disabled={!text} className="inline-flex items-center gap-1 rounded-btn border border-accent-violet bg-accent-violet px-2.5 py-1 text-xs text-white disabled:opacity-50" onClick={() => (dictating ? void deliver(true) : sendHeld(true))}>
            <CornerDownLeft size={13} /> {t('voice.dock.send')}
          </button>
        </div>
      </div>
    </div>
  )
}
