import { Fragment, type ReactNode } from 'react'

/**
 * Tiny, dependency-free markdown renderer for the update changelog. It builds
 * React elements (never dangerouslySetInnerHTML), so a release body can't inject
 * markup. Scope matches GitHub's auto-changelog: headings, bullet lists,
 * paragraphs, bold/italic/inline-code, and [text](url) links that open in the OS
 * browser. Tables, nested emphasis, and bare-URL autolinking are out of scope.
 */

/** Inline tokenizer: code first (so markers inside backticks stay literal), then
 *  links, bold, then italic. Raw text becomes text nodes. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // Fresh regex per call so the /g lastIndex never leaks between invocations.
  const re =
    /(`[^`]+`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*)|((?<![A-Za-z0-9])_[^_\s][^_]*_(?![A-Za-z0-9]))/g
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<Fragment key={`${keyPrefix}-t${i}`}>{text.slice(last, m.index)}</Fragment>)
    }
    if (m[1]) {
      out.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded bg-bg-primary px-1 py-px font-mono text-[11px] text-text-primary"
        >
          {m[1].slice(1, -1)}
        </code>,
      )
    } else if (m[2]) {
      const href = m[4]
      out.push(
        <a
          key={`${keyPrefix}-l${i}`}
          href={href}
          onClick={(e) => {
            e.preventDefault()
            window.snApi.system.openExternal(href)
          }}
          className="text-accent-blue underline decoration-accent-blue/40 underline-offset-2 hover:decoration-accent-blue"
        >
          {m[3]}
        </a>,
      )
    } else if (m[5]) {
      out.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-text-primary">
          {m[5].slice(2, -2)}
        </strong>,
      )
    } else if (m[6]) {
      out.push(<em key={`${keyPrefix}-i${i}`}>{m[6].slice(1, -1)}</em>)
    } else if (m[7]) {
      out.push(<em key={`${keyPrefix}-u${i}`}>{m[7].slice(1, -1)}</em>)
    }
    last = re.lastIndex
    i += 1
  }
  if (last < text.length) {
    out.push(<Fragment key={`${keyPrefix}-tEnd`}>{text.slice(last)}</Fragment>)
  }
  return out
}

interface MdBlock {
  type: 'h' | 'p' | 'ul'
  level: number
  lines: string[]
}

/** Group raw lines into heading / paragraph / list blocks. */
function parseBlocks(src: string): MdBlock[] {
  const blocks: MdBlock[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) blocks.push({ type: 'p', level: 0, lines: [para.join(' ')] })
    para = []
  }
  for (const raw of src.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (line.trim() === '') {
      flushPara()
    } else if (heading) {
      flushPara()
      blocks.push({ type: 'h', level: heading[1].length, lines: [heading[2]] })
    } else if (bullet) {
      flushPara()
      const prev = blocks[blocks.length - 1]
      if (prev && prev.type === 'ul') prev.lines.push(bullet[1])
      else blocks.push({ type: 'ul', level: 0, lines: [bullet[1]] })
    } else {
      para.push(line.trim())
    }
  }
  flushPara()
  return blocks
}

export interface MarkdownProps {
  source: string
  className?: string
}

export function Markdown({ source, className }: MarkdownProps) {
  const blocks = parseBlocks(source)
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          const size = b.level <= 1 ? 'text-sm' : 'text-xs'
          return (
            <div key={i} className={`mb-1 mt-2 font-semibold text-text-primary first:mt-0 ${size}`}>
              {renderInline(b.lines[0], `h${i}`)}
            </div>
          )
        }
        if (b.type === 'ul') {
          return (
            <ul key={i} className="my-1 list-disc space-y-0.5 pl-4 text-text-primary">
              {b.lines.map((li, j) => (
                <li key={j}>{renderInline(li, `ul${i}-${j}`)}</li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i} className="my-1 leading-relaxed text-text-primary first:mt-0">
            {renderInline(b.lines[0], `p${i}`)}
          </p>
        )
      })}
    </div>
  )
}
