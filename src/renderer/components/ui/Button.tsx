import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ariaKeyshortcuts, type ActionId } from '@/lib/keymap'
import { KeyHint, useActionKeys } from './KeyHint'

type Variant = 'primary' | 'ghost'
type Size = 'sm' | 'md'

const base =
  'inline-flex items-center justify-center gap-2 rounded-btn font-medium transition-[transform,filter,background-color,border-color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-violet focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50'

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-5 text-sm',
}

const variants: Record<Variant, string> = {
  primary:
    'text-white bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.6)] hover:brightness-110',
  ghost:
    'text-text-primary border border-border bg-transparent hover:bg-card hover:border-accent-violet/40',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /**
   * Shortcut chip after the label (E4-FR-29): fixed keys (['Enter']) or a
   * keymap action, resolved live. Only for primary actions, never Cancel.
   */
  keyHint?: string[] | ActionId
  children: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  keyHint,
  className,
  children,
  ...rest
}: ButtonProps) {
  const actionKeys = useActionKeys(typeof keyHint === 'string' ? keyHint : null)
  const keys = Array.isArray(keyHint) ? keyHint : actionKeys
  return (
    <button
      className={cn(base, sizes[size], variants[variant], className)}
      aria-keyshortcuts={keys.length > 0 ? ariaKeyshortcuts(keys) : undefined}
      {...rest}
    >
      {children}
      {keys.length > 0 && <KeyHint keys={keys} tone={variant === 'primary' ? 'onAccent' : 'muted'} />}
    </button>
  )
}
