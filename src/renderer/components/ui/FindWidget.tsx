/**
 * Find and replace inside a panel, VS Code style (v2.3): a card that floats
 * over the top right of the text with the query, the Aa / whole word / regex
 * toggles, the "3 of 12" counter, previous / next / close and, when the
 * surface is editable, a replace row behind the chevron. Presentational: the
 * caller owns the search (`editor/cmFind.tsx` for CodeMirror). Its keys only
 * act while it has the focus (`findLogic.ts`); Esc never reaches the drawer.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, WholeWord, X } from 'lucide-react'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { findKeyAction, resultLabel, type FindField, type FindOptions, type FindResult } from './findLogic'

export interface FindWidgetReplace {
  open: boolean
  onOpen: (open: boolean) => void
  value: string
  onValue: (value: string) => void
  onReplace: () => void
  onReplaceAll: () => void
}

export interface FindWidgetProps {
  query: string
  onQuery: (query: string) => void
  options: FindOptions
  onOptions: (options: FindOptions) => void
  result: FindResult | null
  /** The query is a regular expression that does not compile. */
  invalid?: boolean
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  /** Bump to focus and select the find field again (Ctrl+F while open). */
  focusToken?: number
  /** Bump (from 1) to focus the replace field, once its row shows (Ctrl+H from the text). */
  replaceFocusToken?: number
  /** Omitted on a read-only surface: no chevron, no replace row. */
  replace?: FindWidgetReplace
  /** Keys the widget does not use (the host's own find keys). */
  onOtherKey?: (e: KeyboardEvent<HTMLDivElement>) => void
}

/** Buttons keep the focus in the field, as in VS Code. */
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault()

const focusField = (el: HTMLInputElement | null): void => {
  el?.focus({ preventScroll: true })
  el?.select()
}

function IconButton({ label, onClick, disabled, pressed, expanded, children, data }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; expanded?: boolean; children: ReactNode; data?: string }) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-expanded={expanded}
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={onClick}
        className={cn(
          'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-btn transition-colors disabled:opacity-40 disabled:hover:bg-transparent',
          pressed ? 'bg-accent-violet/20 text-text-primary ring-1 ring-accent-violet/60' : 'text-text-secondary hover:bg-bg-secondary hover:text-text-primary',
        )}
        data-find-action={data}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function Toggle({ label, on, onClick, children, data }: { label: string; on: boolean; onClick: () => void; children: ReactNode; data: string }) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={on}
        onMouseDown={keepFocus}
        onClick={onClick}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded transition-colors',
          on ? 'bg-accent-violet/20 text-text-primary ring-1 ring-accent-violet/60' : 'text-text-secondary hover:bg-card hover:text-text-primary',
        )}
        data-find-toggle={data}
        data-on={on ? 'true' : 'false'}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export function FindWidget(props: FindWidgetProps) {
  const t = useT()
  const { query, options, result, invalid, replace } = props
  const findRef = useRef<HTMLInputElement | null>(null)
  const replaceRef = useRef<HTMLInputElement | null>(null)
  const wantReplaceFocus = useRef(false)

  // Mounting (the host opened it) and every bump take the keyboard to the query.
  useEffect(() => {
    const el = findRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
  }, [props.focusToken])

  // Ctrl+H from the text: the replace field takes the keyboard (after the query took it on mount).
  useEffect(() => {
    if (props.replaceFocusToken) focusField(replaceRef.current)
  }, [props.replaceFocusToken])

  // Ctrl+H from the widget opens the replace row with the focus in it.
  useEffect(() => {
    if (!replace?.open || !wantReplaceFocus.current) return
    wantReplaceFocus.current = false
    focusField(replaceRef.current)
  }, [replace?.open])

  const empty = !!query && !invalid && (!result || result.total === 0)
  const label = resultLabel(query, result, !!invalid, t)
  const toggle = (k: keyof FindOptions): void => props.onOptions({ ...options, [k]: !options[k] })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const field: FindField = e.target === findRef.current ? 'find' : e.target === replaceRef.current ? 'replace' : 'other'
    const action = findKeyAction(e, field)
    if (!action) {
      props.onOtherKey?.(e)
      return
    }
    if ((action === 'replace' || action === 'replaceAll') && !replace) return
    e.preventDefault()
    e.stopPropagation()
    if (action === 'next') props.onNext()
    else if (action === 'prev') props.onPrev()
    else if (action === 'close') props.onClose()
    else if (action === 'toggleCase') toggle('caseSensitive')
    else if (action === 'toggleWord') toggle('wholeWord')
    else if (action === 'toggleRegex') toggle('regexp')
    else if (action === 'focusFind') {
      // Ctrl+F is find alone, as in VS Code: the replace row hides (the chevron or Ctrl+H bring it back).
      findRef.current?.focus({ preventScroll: true })
      findRef.current?.select()
      if (replace?.open) replace.onOpen(false)
    } else if (action === 'openReplace') {
      if (!replace) return
      if (replace.open) focusField(replaceRef.current)
      else {
        wantReplaceFocus.current = true
        replace.onOpen(true)
      }
    } else if (action === 'replace') replace?.onReplace()
    else if (action === 'replaceAll') replace?.onReplaceAll()
  }

  const field = 'h-8 w-full min-w-0 rounded-btn border bg-bg-primary text-[13px] text-text-primary outline-none placeholder:text-text-secondary/70'

  return (
    <div
      role="search"
      aria-label={t('find.placeholder')}
      onKeyDown={onKeyDown}
      className="@container absolute right-4 top-2 z-20 w-[min(460px,calc(100%-24px))] rounded-card border border-border bg-card p-1.5 font-sans shadow-lg"
      data-find-widget
    >
      {/* Narrow (a split note): the counter and the arrows wrap under the query; very narrow, the toggles too. */}
      <div className="flex flex-wrap items-center gap-1">
        {replace && (
          <IconButton label={t('find.toggleReplace')} onClick={() => replace.onOpen(!replace.open)} expanded={replace.open} data="toggleReplace">
            {replace.open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </IconButton>
        )}
        <div className="relative min-w-0 flex-1 @max-[240px]:flex @max-[240px]:flex-wrap @max-[240px]:gap-1">
          <input
            ref={findRef}
            value={query}
            onChange={(e) => props.onQuery(e.target.value)}
            placeholder={t('find.placeholder')}
            aria-label={t('find.placeholder')}
            aria-invalid={invalid || empty ? true : undefined}
            spellCheck={false}
            className={cn(field, 'pl-2 pr-[84px] @max-[240px]:pr-2', invalid || empty ? 'border-state-error' : 'border-border focus:border-accent-violet')}
            main-field="true"
            data-find-input
          />
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 @max-[240px]:static @max-[240px]:translate-y-0">
            <Toggle label={t('find.matchCase')} on={options.caseSensitive} onClick={() => toggle('caseSensitive')} data="case">
              <CaseSensitive size={15} />
            </Toggle>
            <Toggle label={t('find.wholeWord')} on={options.wholeWord} onClick={() => toggle('wholeWord')} data="word">
              <WholeWord size={15} />
            </Toggle>
            <Toggle label={t('find.regex')} on={options.regexp} onClick={() => toggle('regexp')} data="regex">
              <Regex size={15} />
            </Toggle>
          </div>
        </div>
        <span aria-hidden className="hidden h-0 basis-full @max-[360px]:block" />
        <span
          aria-live="polite"
          className={cn(
            'min-w-[76px] shrink-0 truncate px-1 text-center text-xs tabular-nums @max-[360px]:min-w-0 @max-[360px]:flex-1 @max-[360px]:text-left',
            replace && '@max-[360px]:pl-[31px]',
            '@max-[240px]:px-0',
            invalid || empty ? 'text-state-error' : 'text-text-secondary',
          )}
          data-find-count
        >
          {label}
        </span>
        <IconButton label={t('find.prev')} onClick={props.onPrev} disabled={!result || result.total === 0} data="prev">
          <ArrowUp size={15} />
        </IconButton>
        <IconButton label={t('find.next')} onClick={props.onNext} disabled={!result || result.total === 0} data="next">
          <ArrowDown size={15} />
        </IconButton>
        <IconButton label={t('find.close')} onClick={props.onClose} data="close">
          <X size={15} />
        </IconButton>
      </div>
      {replace?.open && (
        <div className="mt-1 flex items-center gap-1" data-find-replace-row>
          <span className="w-[26px] shrink-0 @max-[240px]:hidden" />
          <input
            ref={replaceRef}
            value={replace.value}
            onChange={(e) => replace.onValue(e.target.value)}
            placeholder={t('find.replacePlaceholder')}
            aria-label={t('find.replacePlaceholder')}
            spellCheck={false}
            className={cn(field, 'border-border px-2 focus:border-accent-violet')}
            data-find-replace-input
          />
          <IconButton label={t('find.replace')} onClick={replace.onReplace} disabled={!result || result.total === 0} data="replace">
            <Replace size={15} />
          </IconButton>
          <IconButton label={t('find.replaceAll')} onClick={replace.onReplaceAll} disabled={!result || result.total === 0} data="replaceAll">
            <ReplaceAll size={15} />
          </IconButton>
          {/* Lines the buttons up under the counter and the arrows. */}
          <span className="w-[106px] shrink-0 @max-[360px]:hidden" />
        </div>
      )}
    </div>
  )
}
