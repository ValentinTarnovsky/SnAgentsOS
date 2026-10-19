/**
 * One chat message (E3-FR-27/29/32): the user's prompt as a right-hand bubble
 * folded to 4 lines with "Show more"; the assistant's markdown full width;
 * thinking as a folded "Thinking" row; system rows (an interrupt, a skipped
 * record, local command output) grey and centered; images as a chip. A
 * long-press opens the message actions (Copy, Select text).
 */
import { useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Brain, ChevronRight } from 'lucide-react'
import type { ChatBlock, ChatRole } from '@shared/chat-types'
import { needsFold, systemKey } from '../../lib/chatModel'
import { useLongPress } from '../../lib/longPress'
import { t } from '../../lib/i18n'
import { Markdown } from './Markdown'

function ImageChip(): ReactNode {
  return (
    <span data-chat-image className="inline-flex rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary">
      {t('chat.image')}
    </span>
  )
}

function Thinking({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div data-chat-thinking className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-9 items-center gap-1.5 rounded-btn px-1 text-xs italic text-text-secondary active:bg-card"
      >
        <Brain size={13} aria-hidden />
        {t('chat.thinking')}
        <ChevronRight size={13} className={clsx('transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
      </button>
      {open && <div className="whitespace-pre-wrap border-l-2 border-border pl-2 text-xs text-text-secondary [overflow-wrap:anywhere]">{text}</div>}
    </div>
  )
}

function UserBubble({ blocks }: { blocks: ChatBlock[] }): ReactNode {
  const text = blocks.map((b) => (b.t === 'text' ? b.text : '')).filter(Boolean).join('\n\n')
  const images = blocks.filter((b) => b.t === 'image').length
  const fold = needsFold(text)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex justify-end px-3">
      <div data-chat-user className="flex min-w-0 max-w-[85%] flex-col items-end gap-1">
        {text && (
          <div
            data-chat-bubble
            data-folded={fold && !open ? 'true' : 'false'}
            className={clsx(
              'min-w-0 max-w-full whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-violet px-3 py-2 text-sm text-white [overflow-wrap:anywhere]',
              fold && !open && 'line-clamp-4',
            )}
          >
            {text}
          </div>
        )}
        {fold && (
          <button type="button" data-chat-more onClick={() => setOpen((o) => !o)} className="min-h-8 px-1 text-xs font-medium text-accent-violet">
            {open ? t('chat.showLess') : t('chat.showMore')}
          </button>
        )}
        {images > 0 && (
          <div className="flex gap-1">
            {Array.from({ length: images }, (_, i) => (
              <ImageChip key={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SystemRow({ blocks }: { blocks: ChatBlock[] }): ReactNode {
  const text = blocks.map((b) => (b.t === 'text' ? b.text : '')).join('\n')
  const key = systemKey(text)
  return (
    <div data-chat-system className="flex justify-center px-6">
      <span className="max-w-full whitespace-pre-wrap text-center text-[11px] text-text-secondary [overflow-wrap:anywhere]">{key ? t(key) : text}</span>
    </div>
  )
}

function AssistantBody({ blocks }: { blocks: ChatBlock[] }): ReactNode {
  return (
    <div data-chat-assistant className="flex min-w-0 flex-col gap-1 px-3">
      {blocks.map((b, i) =>
        b.t === 'text' ? (
          <Markdown key={i} text={b.text} />
        ) : b.t === 'thinking' ? (
          <Thinking key={i} text={b.text} />
        ) : b.t === 'image' ? (
          <div key={i}>
            <ImageChip />
          </div>
        ) : null,
      )}
    </div>
  )
}

export interface MessageRowProps {
  id: string
  role: Exclude<ChatRole, 'tool'>
  blocks: ChatBlock[]
  /** Long-press: the message actions for this row. */
  onActions: (id: string, el: HTMLElement | null) => void
  /** "Select text" picked: the row lets the browser select its text. */
  selectable: boolean
}

export function MessageRow({ id, role, blocks, onActions, selectable }: MessageRowProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const press = useLongPress(() => onActions(id, ref.current))
  return (
    <div
      ref={ref}
      data-chat-row={role}
      data-chat-id={id}
      {...(selectable ? {} : press)}
      className={clsx('min-w-0', selectable ? 'select-text' : 'select-none [-webkit-touch-callout:none]')}
    >
      {role === 'user' ? <UserBubble blocks={blocks} /> : role === 'system' ? <SystemRow blocks={blocks} /> : <AssistantBody blocks={blocks} />}
    </div>
  )
}
