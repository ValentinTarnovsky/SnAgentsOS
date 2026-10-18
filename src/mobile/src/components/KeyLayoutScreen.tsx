/**
 * "Key bar" settings screen (E2-FR-45, 46), pushed over Settings. Lists every
 * key of the scroll zone in its current order: the built-ins, the desktop's
 * keyButtons and the phone's custom keys. Each row has a visibility switch
 * and 44px move up / move down buttons; custom rows also open the builder
 * (CustomKeySheet). Below the list: [New key] (up to MAX_CUSTOM_KEYS) and
 * [Reset], which restores the default order with every key visible and keeps
 * the custom keys at the end. The keyboard toggle is fixed in the bar and is
 * not listed. Every change is saved at once to `snagentsos.keybar`.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ClipboardPaste, Delete, Pencil, Plus, RotateCcw, Zap } from 'lucide-react'
import { PushScreen } from './PushScreen'
import { CustomKeySheet, SwitchPill } from './CustomKeySheet'
import { useRemoteStore } from '../lib/store'
import { useKeyLayout, useKeyLayoutStore } from '../lib/keyLayout'
import { t } from '../lib/i18n'
import {
  CUSTOM_PREFIX,
  DESK_PREFIX,
  layoutKeyDefs,
  MAX_CUSTOM_KEYS,
  moveKey,
  removeCustomKey,
  resetLayout,
  setKeyVisible,
  upsertCustomKey,
  type CustomKey,
  type KeyDef,
  type KeyIcon,
} from '../lib/keys'

const ICONS: Record<KeyIcon, ReactNode> = {
  left: <ChevronLeft size={16} />,
  up: <ChevronUp size={16} />,
  down: <ChevronDown size={16} />,
  right: <ChevronRight size={16} />,
  backspace: <Delete size={16} />,
  paste: <ClipboardPaste size={16} />,
  quick: <Zap size={16} />,
}

/** The row's readable name: the aria text for icon keys, else the visible label. */
function keyName(def: KeyDef): string {
  if (def.ariaKey) return t(def.ariaKey)
  if (def.labelKey) return t(def.labelKey)
  return def.label ?? def.id
}

const moveClass =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-btn border border-border bg-card text-text-primary active:bg-bg-primary disabled:opacity-30'

export function KeyLayoutScreen({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const { layout, deskButtons } = useKeyLayout()
  const save = useKeyLayoutStore((s) => s.save)
  const setToast = useRemoteStore((s) => s.setToast)
  // undefined = closed, null = a new key, else the key being edited.
  const [editing, setEditing] = useState<CustomKey | null | undefined>(undefined)
  const [sheetKey, setSheetKey] = useState<CustomKey | null>(null)
  const rows = layoutKeyDefs(layout, deskButtons)
  const visible = new Set(layout.visibleIds)
  const atLimit = layout.custom.length >= MAX_CUSTOM_KEYS

  const openSheet = (key: CustomKey | null): void => {
    setSheetKey(key)
    setEditing(key)
  }

  return (
    <>
      <PushScreen id="keybar" open={open} onClose={onClose} title={t('keybar.title')}>
        <p className="mb-3 px-1 text-[11px] text-text-secondary">{t('keybar.hint')}</p>
        <ul data-keybar-list className="mb-4 flex flex-col overflow-hidden rounded-card border border-border bg-bg-secondary">
          {rows.map((def, i) => {
            const name = keyName(def)
            const shown = visible.has(def.id)
            const custom = def.id.startsWith(CUSTOM_PREFIX) ? layout.custom.find((c) => c.id === def.id) : undefined
            const kind = def.id.startsWith(DESK_PREFIX) ? t('keybar.kindDesk') : custom ? t('keybar.kindCustom') : null
            return (
              <li
                key={def.id}
                data-key-row={def.id}
                data-visible={shown ? 'true' : 'false'}
                className={clsx('flex min-h-14 items-center gap-2 px-3 py-1.5', i > 0 && 'border-t border-border')}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={shown}
                  aria-label={t('keybar.show', { key: name })}
                  data-key-toggle
                  onClick={() => save(setKeyVisible(layout, def.id, !shown))}
                  className="flex h-11 shrink-0 items-center"
                >
                  <SwitchPill on={shown} />
                </button>
                <span className={clsx('flex min-w-0 flex-1 items-center gap-2', !shown && 'opacity-50')}>
                  <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-btn border border-border bg-card px-2 font-mono text-xs text-text-primary">
                    {def.icon ? ICONS[def.icon] : def.labelKey ? t(def.labelKey) : def.label}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">{name}</span>
                    {kind && <span className="block truncate text-[11px] text-text-secondary">{kind}</span>}
                  </span>
                </span>
                {custom && (
                  <button
                    type="button"
                    data-key-edit
                    aria-label={t('keybar.edit', { key: name })}
                    onClick={() => openSheet(custom)}
                    className={moveClass}
                  >
                    <Pencil size={16} />
                  </button>
                )}
                <button
                  type="button"
                  data-key-up
                  aria-label={t('keybar.moveUp', { key: name })}
                  disabled={i === 0}
                  onClick={() => save(moveKey(layout, def.id, -1))}
                  className={moveClass}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  type="button"
                  data-key-down
                  aria-label={t('keybar.moveDown', { key: name })}
                  disabled={i === rows.length - 1}
                  onClick={() => save(moveKey(layout, def.id, 1))}
                  className={moveClass}
                >
                  <ArrowDown size={16} />
                </button>
              </li>
            )
          })}
        </ul>
        <button
          type="button"
          data-keybar-add
          disabled={atLimit}
          onClick={() => openSheet(null)}
          className="mb-1 flex h-12 w-full items-center justify-center gap-2 rounded-btn border border-border bg-bg-secondary text-sm font-medium text-text-primary active:bg-card disabled:opacity-40"
        >
          <Plus size={16} />
          {t('keybar.add')}
        </button>
        <p className="mb-4 px-1 text-[11px] text-text-secondary">{t('keybar.limit', { n: MAX_CUSTOM_KEYS })}</p>
        <button
          type="button"
          data-keybar-reset
          onClick={() => {
            save(resetLayout(layout, deskButtons))
            setToast(t('keybar.resetDone'))
          }}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-btn border border-border bg-bg-secondary text-sm font-medium text-text-primary active:bg-card"
        >
          <RotateCcw size={16} />
          {t('keybar.reset')}
        </button>
      </PushScreen>
      <CustomKeySheet
        open={editing !== undefined}
        initial={sheetKey}
        takenIds={layout.orderedIds}
        onClose={() => setEditing(undefined)}
        onSave={(key) => {
          const next = upsertCustomKey(layout, key)
          if (next) save(next)
        }}
        onDelete={(id) => save(removeCustomKey(layout, id))}
      />
    </>
  )
}
