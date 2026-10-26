/**
 * One message of a desktop chat (the share guest's, app 2.4.0 item 8 S5; the
 * console chat, app 2.7.0 A7), ported from the phone's MessageRow
 * (src/mobile/src/components/chat): the prompt as a right-hand bubble folded
 * to 4 lines with "Show more", the assistant's markdown full width, thinking
 * as a folded row, system rows grey and centered, images as a chip. On the
 * desktop the text selects as usual and a Copy button shows on hover (the
 * phone's long-press menu is not needed).
 */
import { useState } from 'react'
import { Brain, Check, ChevronRight, Copy } from 'lucide-react'
import type { ChatBlock, ChatRole } from '@shared/chat-types'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { messageText, needsFold, systemKey } from './chatModel'
import { ChatMarkdown } from './Markdown'

function ImageChip() {
  const t = useT()
  return (
    <span data-chat-image className="inline-flex rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary">
      {t('md.image')}
    </span>
  )
}

function Thinking({ text }: { text: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div data-chat-thinking className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-7 items-center gap-1.5 rounded-btn px-1 text-xs italic text-text-secondary hover:bg-card"
      >
        <Brain size={13} aria-hidden />
        {t('shareGuest.chat.thinking')}
        <ChevronRight size={13} className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
      </button>
      {open && <div className="whitespace-pre-wrap border-l-2 border-border pl-2 text-xs text-text-secondary [overflow-wrap:anywhere]">{text}</div>}
    </div>
  )
}

function UserBubble({ blocks }: { blocks: ChatBlock[] }) {
  const t = useT()
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
            className={cn(
              'min-w-0 max-w-full whitespace-pre-wrap rounded-2xl rounded-br-md bg-card px-3 py-2 text-[13px] text-text-primary [overflow-wrap:anywhere]',
              fold && !open && 'line-clamp-4',
            )}
          >
            {text}
          </div>
        )}
        {fold && (
          <button type="button" data-chat-more onClick={() => setOpen((o) => !o)} className="px-1 text-xs font-medium text-accent-violet hover:underline">
            {open ? t('shareGuest.chat.showLess') : t('shareGuest.chat.showMore')}
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

function SystemRow({ blocks }: { blocks: ChatBlock[] }) {
  const t = useT()
  const text = blocks.map((b) => (b.t === 'text' ? b.text : '')).join('\n')
  const key = systemKey(text)
  return (
    <div data-chat-system className="flex justify-center px-6">
      <span className="max-w-full whitespace-pre-wrap text-center text-[11px] text-text-secondary [overflow-wrap:anywhere]">{key ? t(key) : text}</span>
    </div>
  )
}

function AssistantBody({ blocks, onLink }: { blocks: ChatBlock[]; onLink: (href: string) => void }) {
  return (
    <div data-chat-assistant className="flex min-w-0 flex-col gap-1 px-3">
      {blocks.map((b, i) =>
        b.t === 'text' ? (
          <ChatMarkdown key={i} text={b.text} onLink={onLink} />
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
  /** An http/https link in the message, never opened here (the share guest confirms it first). */
  onLink: (href: string) => void
}

export function MessageRow({ id, role, blocks, onLink }: MessageRowProps) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const text = role === 'system' ? '' : messageText(blocks)
  return (
    <div data-chat-row={role} data-chat-id={id} className="group/msg relative min-w-0 select-text">
      {role === 'user' ? <UserBubble blocks={blocks} /> : role === 'system' ? <SystemRow blocks={blocks} /> : <AssistantBody blocks={blocks} onLink={onLink} />}
      {text && (
        <Tooltip label={t('shareGuest.chat.copy')} className={cn('absolute top-0', role === 'user' ? 'left-1' : 'right-1')}>
          <button
            type="button"
            aria-label={t('shareGuest.chat.copy')}
            data-chat-copy={id}
            onClick={() => {
              window.snApi.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-text-secondary opacity-0 transition-opacity hover:bg-card hover:text-text-primary focus-visible:opacity-100 group-hover/msg:opacity-100"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </Tooltip>
      )}
    </div>
  )
}
