/**
 * Markdown of the agent's messages (E3-FR-27/32), safe by construction:
 * `marked` only tokenizes (its lexer, no renderer) and every token becomes a
 * React node, so nothing is ever injected as HTML. Raw HTML shows as text,
 * links open only with http/https (new tab, noopener noreferrer), images
 * are a "[Image]" chip and never load, and code blocks scroll sideways with
 * a Copy button.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Lexer, type Token, type Tokens } from 'marked'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../../lib/clipboard'
import { safeHref } from '../../lib/chatModel'
import { t } from '../../lib/i18n'

/** The lexer escapes inline text for its own HTML renderer; React escapes again, so undo it. */
function unescapeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? _)
}

function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <div data-md-code className="relative my-2 min-w-0 max-w-full rounded-btn border border-border bg-bg-primary">
      <div className="flex items-center justify-between border-b border-border px-2 py-0.5">
        <span className="font-mono text-[10px] text-text-secondary">{lang || ''}</span>
        <button
          type="button"
          data-md-copy
          aria-label={t('chat.copyCode')}
          onClick={() => {
            if (copyText(code)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }}
          className="-mr-1 flex h-8 w-8 items-center justify-center rounded-btn text-text-secondary active:bg-card"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre data-scrollable className="max-w-full overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] text-text-primary">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function inline(tokens: Token[] | undefined, key: string): ReactNode[] {
  if (!tokens) return []
  return tokens.map((tok, i) => inlineToken(tok, `${key}.${i}`))
}

function inlineToken(tok: Token, key: string): ReactNode {
  switch (tok.type) {
    case 'text': {
      const tt = tok as Tokens.Text
      return tt.tokens && tt.tokens.length ? <span key={key}>{inline(tt.tokens, key)}</span> : <span key={key}>{unescapeHtml(tt.text)}</span>
    }
    case 'escape':
      return <span key={key}>{unescapeHtml((tok as Tokens.Escape).text)}</span>
    case 'strong':
      return <strong key={key}>{inline((tok as Tokens.Strong).tokens, key)}</strong>
    case 'em':
      return <em key={key}>{inline((tok as Tokens.Em).tokens, key)}</em>
    case 'del':
      return <del key={key}>{inline((tok as Tokens.Del).tokens, key)}</del>
    case 'codespan':
      return (
        <code key={key} className="rounded bg-bg-primary px-1 py-px font-mono text-[0.9em] [overflow-wrap:anywhere]">
          {unescapeHtml((tok as Tokens.Codespan).text)}
        </code>
      )
    case 'br':
      return <br key={key} />
    case 'link': {
      const link = tok as Tokens.Link
      const href = safeHref(link.href)
      const body = link.tokens && link.tokens.length ? inline(link.tokens, key) : unescapeHtml(link.text)
      if (!href) return <span key={key} data-md-inert-link>{body}</span>
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-accent-violet underline [overflow-wrap:anywhere]">
          {body}
        </a>
      )
    }
    case 'image':
      return (
        <span key={key} data-chat-image className="mx-0.5 inline-flex rounded border border-border px-1 text-[11px] text-text-secondary">
          {t('chat.image')}
        </span>
      )
    case 'html':
      // Raw HTML is shown as typed (FR-32).
      return <span key={key}>{(tok as Tokens.HTML).raw}</span>
    default:
      return <span key={key}>{'raw' in tok ? String(tok.raw) : ''}</span>
  }
}

function blocks(tokens: Token[], key: string): ReactNode[] {
  const out: ReactNode[] = []
  tokens.forEach((tok, i) => {
    const k = `${key}.${i}`
    switch (tok.type) {
      case 'space':
      case 'def':
        return
      case 'code': {
        const code = tok as Tokens.Code
        out.push(<CodeBlock key={k} code={code.text} lang={code.lang} />)
        return
      }
      case 'heading': {
        const h = tok as Tokens.Heading
        out.push(
          <div key={k} role="heading" aria-level={Math.min(6, Math.max(1, h.depth))} className="mb-1 mt-2 font-semibold text-text-primary">
            {inline(h.tokens, k)}
          </div>,
        )
        return
      }
      case 'hr':
        out.push(<hr key={k} className="my-2 border-border" />)
        return
      case 'blockquote':
        out.push(
          <blockquote key={k} className="my-1 border-l-2 border-border pl-3 text-text-secondary">
            {blocks((tok as Tokens.Blockquote).tokens, k)}
          </blockquote>,
        )
        return
      case 'list': {
        const list = tok as Tokens.List
        const items = list.items.map((item, j) => (
          <li key={`${k}.${j}`} className="min-w-0">
            {item.task ? <span aria-hidden>{item.checked ? '[x] ' : '[ ] '}</span> : null}
            {blocks(item.tokens, `${k}.${j}`)}
          </li>
        ))
        out.push(
          list.ordered ? (
            <ol key={k} start={typeof list.start === 'number' ? list.start : undefined} className="my-1 list-decimal pl-5">
              {items}
            </ol>
          ) : (
            <ul key={k} className="my-1 list-disc pl-5">
              {items}
            </ul>
          ),
        )
        return
      }
      case 'paragraph':
        out.push(
          <p key={k} className="my-1">
            {inline((tok as Tokens.Paragraph).tokens, k)}
          </p>,
        )
        return
      case 'text': {
        const tt = tok as Tokens.Text
        out.push(<span key={k}>{tt.tokens && tt.tokens.length ? inline(tt.tokens, k) : unescapeHtml(tt.text)}</span>)
        return
      }
      case 'html':
        out.push(
          <p key={k} className="my-1 whitespace-pre-wrap">
            {(tok as Tokens.HTML).raw}
          </p>,
        )
        return
      case 'table': {
        const table = tok as Tokens.Table
        out.push(
          <div key={k} data-scrollable className="my-2 max-w-full overflow-x-auto">
            <table className="border-collapse text-[12px]">
              <thead>
                <tr>
                  {table.header.map((cell, j) => (
                    <th key={j} className="border border-border px-2 py-1 text-left font-semibold">
                      {inline(cell.tokens, `${k}.h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, j) => (
                      <td key={j} className="border border-border px-2 py-1 align-top">
                        {inline(cell.tokens, `${k}.${r}.${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        )
        return
      }
      default:
        out.push(
          <p key={k} className="my-1 whitespace-pre-wrap">
            {'raw' in tok ? String(tok.raw) : ''}
          </p>,
        )
    }
  })
  return out
}

export function Markdown({ text }: { text: string }): ReactNode {
  const tokens = useMemo(() => {
    try {
      return Lexer.lex(text, { gfm: true, breaks: true })
    } catch {
      return null
    }
  }, [text])
  if (!tokens) return <p className="whitespace-pre-wrap">{text}</p>
  return (
    <div data-md className="min-w-0 max-w-full break-words text-sm leading-[1.45] text-text-primary [overflow-wrap:anywhere]">
      {blocks(tokens, 'm')}
    </div>
  )
}
