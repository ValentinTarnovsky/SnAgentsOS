/**
 * Centered full-screen message used by the non-terminal states (connecting,
 * welcome, revoked, re-pair, impostor, locked). Optional spinner, accent-tinted
 * icon slot, and a primary action button.
 */
import type { ReactNode } from 'react'

interface InfoScreenProps {
  icon?: ReactNode
  title: string
  body?: string
  spinner?: boolean
  tone?: 'neutral' | 'danger' | 'accent'
  children?: ReactNode
}

export function InfoScreen({ icon, title, body, spinner, tone = 'neutral', children }: InfoScreenProps): ReactNode {
  const ring =
    tone === 'danger'
      ? 'text-red-400 bg-red-500/10'
      : tone === 'accent'
        ? 'text-accent-violet bg-accent-violet/10'
        : 'text-text-secondary bg-bg-secondary'
  return (
    <div
      className="fade-in flex flex-col items-center justify-center px-6 text-center"
      style={{ height: 'var(--vvh, 100dvh)' }}
    >
      <div className="w-full max-w-sm">
        {spinner && (
          <div className="mx-auto mb-6 h-10 w-10 rounded-full border-2 border-border border-t-accent-violet spin" />
        )}
        {icon && (
          <div className={`mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl ${ring}`}>{icon}</div>
        )}
        <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
        {body && <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>}
        {children && <div className="mt-6">{children}</div>}
      </div>
    </div>
  )
}

/** Full-width primary button used across the info screens and sheets. */
export function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-12 w-full rounded-btn bg-accent-violet px-4 text-sm font-semibold text-white transition active:brightness-110 disabled:opacity-40"
    >
      {children}
    </button>
  )
}
