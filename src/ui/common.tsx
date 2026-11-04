import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { formatDate, formatDateTime } from '../domain/format.ts'
import { STATUSES, transitionsFrom, type StatusKey } from '../domain/status.ts'
import { displayName, users } from '../store.ts'
import { Icon } from './icons.tsx'

const AVATAR_COLORS = 8

function hash(text: string): number {
  let value = 0
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}

function initials(name: string): string {
  const words = name.split(/[\s_.-]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)
  return letters.toUpperCase()
}

export function Avatar({ login, name, size = 'm' }: { login: string | null; name?: string | null; size?: 's' | 'm' | 'l' }) {
  const label = name || displayName(login) || login || '?'
  const color = login ? hash(login) % AVATAR_COLORS : 'none'
  return (
    <span class={`avatar avatar--${size} avatar--c${color}`} title={label} aria-hidden="true">
      {login || name ? initials(label) : <Icon name="user" size={12} />}
    </span>
  )
}

export function Person({ login, name, empty = 'Не назначен' }: { login: string | null; name?: string | null; empty?: string }) {
  if (!login && !name) return <span class="person person--empty">{empty}</span>
  return (
    <span class="person">
      <Avatar login={login} name={name ?? null} size="s" />
      <span class="person__name">{name || displayName(login)}</span>
    </span>
  )
}

export function StatusLabel({ status, size = 'm' }: { status: StatusKey; size?: 's' | 'm' }) {
  const info = STATUSES[status]
  return <span class={`label label--${info.tone} label--${size}`}>{info.title}</span>
}

export function DateText({ iso, prefix }: { iso: string; prefix?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {prefix}
      {formatDate(iso)}
    </time>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} aria-label="Загрузка" />
}

interface MenuProps {
  label: ComponentChildren
  triggerClass?: string
  title?: string
  align?: 'start' | 'end'
  disabled?: boolean
  children: (close: () => void) => ComponentChildren
}

/** Выпадающее меню: закрывается по клику мимо, Escape и выбору пункта. */
export function Menu({ label, triggerClass = 'btn btn--flat', title, align = 'start', disabled, children }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !panel.current || !root.current) return
    const trigger = root.current.getBoundingClientRect()
    const height = panel.current.offsetHeight
    setUp(trigger.bottom + height + 8 > window.innerHeight && trigger.top > height + 8)
  }, [open])

  return (
    <div class="menu-anchor" ref={root}>
      <button
        type="button"
        class={triggerClass}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(!open)
        }}
      >
        {label}
      </button>
      {open && (
        <div ref={panel} class={`menu menu--${align}${up ? ' menu--up' : ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  onSelect,
  children,
  selected,
  danger,
}: {
  onSelect: () => void
  children: ComponentChildren
  selected?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      class={`menu__item${selected ? ' is-selected' : ''}${danger ? ' menu__item--danger' : ''}`}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onSelect()
      }}
    >
      <span class="menu__item-body">{children}</span>
      {selected && <Icon name="check" size={14} />}
    </button>
  )
}

/** Выбор исполнителя: «Не назначен» и все, кому можно назначить задачи в репозитории. */
export function UserPicker({
  value,
  onChange,
  triggerClass = 'btn btn--flat btn--field',
  align = 'start',
  emptyLabel = 'Не назначен',
  compact = false,
}: {
  value: string | null
  onChange: (login: string | null) => void
  triggerClass?: string
  align?: 'start' | 'end'
  emptyLabel?: string
  compact?: boolean
}) {
  const people = [...users.value.values()].sort((a, b) => (a.name || a.login).localeCompare(b.name || b.login, 'ru'))
  return (
    <Menu
      triggerClass={triggerClass}
      align={align}
      title={value ? `Исполнитель: ${displayName(value)}` : 'Назначить исполнителя'}
      label={
        compact ? (
          value ? <Avatar login={value} size="s" /> : <span class="avatar avatar--s avatar--empty"><Icon name="user" size={12} /></span>
        ) : (
          <Person login={value} empty={emptyLabel} />
        )
      }
    >
      {(close) => (
        <>
          <MenuItem selected={!value} onSelect={() => (close(), value && onChange(null))}>
            <span class="person person--empty">{emptyLabel}</span>
          </MenuItem>
          {people.map((user) => (
            <MenuItem key={user.login} selected={user.login === value} onSelect={() => (close(), user.login !== value && onChange(user.login))}>
              <Person login={user.login} name={user.name} />
              <span class="menu__hint">{user.login}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  )
}

/** Статус с меню переходов, как кнопка статуса в Трекере. */
export function StatusButton({ status, onChange, disabled }: { status: StatusKey; onChange: (next: StatusKey) => void; disabled?: boolean }) {
  return (
    <Menu
      triggerClass={`status-button label label--${STATUSES[status].tone}`}
      disabled={disabled}
      title="Сменить статус"
      label={
        <>
          {STATUSES[status].title}
          <Icon name="chevronDown" size={14} />
        </>
      }
    >
      {(close) =>
        transitionsFrom(status).map((next) => (
          <MenuItem key={next} onSelect={() => (close(), onChange(next))}>
            <span class={`dot dot--${STATUSES[next].tone}`} />
            {STATUSES[next].action}
          </MenuItem>
        ))
      }
    </Menu>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="empty">
      <div class="empty__title">{title}</div>
      {children && <div class="empty__text">{children}</div>}
    </div>
  )
}
