import { X } from 'lucide-react'
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-solid text-on-accent hover:brightness-110 border-transparent',
  secondary: 'bg-raised text-fg border-line hover:border-line-strong hover:bg-hover',
  ghost: 'bg-transparent text-fg-2 border-transparent hover:bg-hover hover:text-fg',
  danger: 'bg-transparent text-danger border-transparent hover:bg-danger-soft'
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`no-drag inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}

export function IconButton({
  label,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`no-drag inline-flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 ${className}`}
      {...props}
    />
  )
}

export function Badge({
  tone = 'neutral',
  children,
  title
}: {
  tone?: 'neutral' | 'warn' | 'ok' | 'accent'
  children: ReactNode
  title?: string
}) {
  const tones = {
    neutral: 'bg-hover text-fg-2',
    warn: 'bg-warn-soft text-warn',
    ok: 'bg-ok-soft text-ok',
    accent: 'bg-accent-soft text-accent'
  }
  return (
    <span
      title={title}
      className={`inline-flex h-[18px] items-center rounded-full px-2 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

/** A small heading inside a pane. Sentence case, no shouting. */
export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex h-6 items-center justify-between">
      <h3 className="text-[12px] font-semibold text-fg-2">{children}</h3>
      {action}
    </div>
  )
}

/** A rounded filter toggle, as used above the paper list. */
export function Chip({
  active,
  onClick,
  children,
  count
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  count?: number
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors ${
        active
          ? 'border-transparent bg-accent-soft font-medium text-accent'
          : 'border-line text-fg-2 hover:border-line-strong hover:text-fg'
      }`}
    >
      {children}
      {count !== undefined && <span className="text-[11px] opacity-70 tabular-nums">{count}</span>}
    </button>
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  hint?: string
  disabled?: boolean
}

/**
 * A dropdown menu: a trigger and a list of actions. Closes on selection, outside
 * clicks and Escape. `items` may contain `'-'` for a divider.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  label
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode
  items: (MenuItem | '-')[]
  align?: 'start' | 'end'
  label: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div ref={ref} className="no-drag relative inline-flex">
      {trigger({ onClick: () => setOpen((v) => !v), 'aria-expanded': open })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute top-full z-50 mt-1 min-w-[220px] rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow)] ${
            align === 'end' ? 'right-0' : 'left-0'
          }`}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
            const i = all.indexOf(document.activeElement as HTMLElement)
            all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
          }}
        >
          {items.map((it, i) =>
            it === '-' ? (
              <div key={`d${i}`} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none disabled:opacity-40 ${
                  it.danger
                    ? 'text-danger hover:bg-danger-soft focus:bg-danger-soft'
                    : 'text-fg hover:bg-hover focus:bg-hover'
                }`}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-fg-3">
                  {it.icon}
                </span>
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="text-[11px] text-fg-3">{it.hint}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

/** Underlined tabs. `value` is the active key. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label
}: {
  tabs: { key: K; label: string; count?: number | undefined }[]
  value: K
  onChange: (k: K) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-4 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={t.key === value}
          onClick={() => onChange(t.key)}
          className={`-mb-px flex h-8 items-center gap-1 border-b-[1.5px] text-[12.5px] transition-colors ${
            t.key === value
              ? 'border-fg font-medium text-fg'
              : 'border-transparent text-fg-3 hover:text-fg'
          }`}
        >
          {t.label}
          {t.count ? <span className="text-[11px] text-fg-3 tabular-nums">{t.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** Minimal modal: focus-trapped enough for a form, closes on Escape and backdrop click. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 520
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prev?.focus()
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        className="flex max-h-full flex-col rounded-xl border border-line bg-raised shadow-[var(--shadow)]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between px-5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-4 select-text">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export const inputClass =
  'w-full rounded-md border border-line bg-input px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-fg-3 hover:border-line-strong focus:border-accent'

/** Strip Electron's IPC wrapper from an error message before showing it. */
export function cleanError(err: unknown): string {
  return (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
