import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { SetupStep } from '@shared/types'
import { useXterm } from './useXterm'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

export interface TerminalPaneProps {
  paneId: string
  /** Owning workspace, needed to persist per-pane font-size zoom. */
  workspaceId: string
  cwd?: string
  shell?: string
  initialCommand?: string
  /** Pre-launch sequence (e.g. SSH connect) run before initialCommand. */
  setup?: SetupStep[]
  fontSize?: number
  /** Whether this terminal is currently visible (drives refit-on-reveal). */
  isActive?: boolean
}

export function TerminalPane({
  paneId,
  workspaceId,
  cwd,
  shell,
  initialCommand,
  setup,
  fontSize,
  isActive,
}: TerminalPaneProps) {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const ctl = useXterm(termRef, { paneId, cwd, shell, initialCommand, setup, fontSize, isActive })

  const setPaneFontSize = useAppStore((s) => s.setPaneFontSize)
  const globalFont = useAppStore((s) => s.settings.fontSize)

  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')

  // delta = +1/-1 to step, 0 to reset to the global size.
  const zoom = useCallback(
    (delta: number) => {
      const base = fontSize ?? globalFont
      setPaneFontSize(workspaceId, paneId, delta === 0 ? globalFont : base + delta)
    },
    [fontSize, globalFont, paneId, workspaceId, setPaneFontSize],
  )

  // Capture-phase so we preempt xterm for the chrome shortcuts only.
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    if (e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault()
      e.stopPropagation()
      setFindOpen(true)
      return
    }
    if (e.shiftKey) return
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      e.stopPropagation()
      zoom(1)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      e.stopPropagation()
      zoom(-1)
    } else if (e.key === '0') {
      e.preventDefault()
      e.stopPropagation()
      zoom(0)
    }
  }

  // Ctrl+wheel zoom. React's onWheel is passive, so attach natively to allow preventDefault.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      zoom(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom])

  const runSearch = (back: boolean): void => {
    ctl.search(query, { back })
  }
  const closeFind = (): void => {
    setFindOpen(false)
    setQuery('')
    ctl.clearSearch()
    ctl.focus()
  }

  return (
    <div
      ref={wrapRef}
      onKeyDownCapture={onKeyDownCapture}
      className="relative h-full w-full overflow-hidden bg-bg-primary p-2"
    >
      <div ref={termRef} className="h-full w-full" />

      {findOpen && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-btn border border-border bg-card/95 px-2 py-1 shadow-lg backdrop-blur">
          <Search size={13} className="shrink-0 text-text-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              ctl.search(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                runSearch(e.shiftKey)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
            placeholder={t('search.placeholder')}
            className="h-6 w-40 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-secondary"
          />
          <IconBtn label={t('search.prev')} onClick={() => runSearch(true)}>
            <ChevronUp size={13} />
          </IconBtn>
          <IconBtn label={t('search.next')} onClick={() => runSearch(false)}>
            <ChevronDown size={13} />
          </IconBtn>
          <IconBtn label={t('common.close')} onClick={closeFind}>
            <X size={13} />
          </IconBtn>
        </div>
      )}
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className={cn(
        'rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary',
      )}
    >
      {children}
    </button>
  )
}
