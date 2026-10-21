/**
 * Markdown of a shared console's chat and of a shared note (app 2.4.0, item
 * 8, S5): a port of the phone's chat Markdown
 * (src/mobile/src/components/chat/Markdown.tsx), safe by construction:
 * `marked` only tokenizes and every token becomes a React node, so nothing
 * is injected as HTML. The text comes from another PC, so links are never
 * anchors: an http/https link is a button that opens ConfirmLinkDialog with
 * its full target (the visible text can lie), anything else is inert text.
 * Raw HTML shows as text, images are a chip and never load.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Lexer, type Token, type Tokens } from 'marked'
import { Check, Copy } from 'lucide-react'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { safeHref } from './chatModel'

function unescapeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? _)
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <div data-md-code className="relative my-2 min-w-0 max-w-full rounded-btn border border-border bg-bg-secondary">
      <div className="flex items-center justify-between border-b border-border px-2 py-0.5">
        <span className="font-mono text-[10px] text-text-secondary">{lang || ''}</span>
        <button
          type="button"
          aria-label={t('md.copyCode')}
          data-md-copy
          onClick={() => {
            window.snApi.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:bg-card hover:text-text-primary"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] text-text-primary">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Doc({ tokens, onLink }: { tokens: Token[]; onLink: (href: string) => void }) {
  const t = useT()

  const inline = (list: Token[] | undefined, key: string): ReactNode[] => (list ?? []).map((tok, i) => inlineToken(tok, `${key}.${i}`))

  const inlineToken = (tok: Token, key: string): ReactNode => {
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
          <code key={key} className="rounded bg-bg-secondary px-1 py-px font-mono text-[0.9em] [overflow-wrap:anywhere]">
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
          <button
            key={key}
            type="button"
            data-md-link={href}
            onClick={() => onLink(href)}
            className="inline cursor-pointer p-0 text-left text-accent-violet underline [overflow-wrap:anywhere]"
          >
            {body}
          </button>
        )
      }
      case 'image':
        return (
          <span key={key} data-md-image className="mx-0.5 inline-flex rounded border border-border px-1 text-[11px] text-text-secondary">
            {t('md.image')}
          </span>
        )
      case 'html':
        return <span key={key}>{(tok as Tokens.HTML).raw}</span>
      default:
        return <span key={key}>{'raw' in tok ? String(tok.raw) : ''}</span>
    }
  }

  const blocks = (list: Token[], key: string): ReactNode[] => {
    const out: ReactNode[] = []
    list.forEach((tok, i) => {
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
          const l = tok as Tokens.List
          const items = l.items.map((item, j) => (
            <li key={`${k}.${j}`} className="min-w-0">
              {item.task ? <span aria-hidden>{item.checked ? '[x] ' : '[ ] '}</span> : null}
              {blocks(item.tokens, `${k}.${j}`)}
            </li>
          ))
          out.push(
            l.ordered ? (
              <ol key={k} start={typeof l.start === 'number' ? l.start : undefined} className="my-1 list-decimal pl-5">
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
            <div key={k} className="my-2 max-w-full overflow-x-auto">
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

  return <>{blocks(tokens, 'm')}</>
}

export function SharedMarkdown({ text, onLink, className }: { text: string; onLink: (href: string) => void; className?: string }) {
  const tokens = useMemo(() => {
    try {
      return Lexer.lex(text, { gfm: true, breaks: true })
    } catch {
      return null
    }
  }, [text])
  return (
    <div data-md className={cn('min-w-0 max-w-full break-words text-[13px] leading-[1.5] text-text-primary [overflow-wrap:anywhere]', className)}>
      {tokens ? <Doc tokens={tokens} onLink={onLink} /> : <p className="whitespace-pre-wrap">{text}</p>}
    </div>
  )
}
