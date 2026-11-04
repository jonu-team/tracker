import { useEffect, useState } from 'preact/hooks'
import type { Issue } from '../domain/issue.ts'
import { STATUSES, STATUS_ORDER, type StatusKey } from '../domain/status.ts'
import { navigate, withQuery } from '../router.ts'
import { displayName, session, users } from '../store.ts'
import { Menu, MenuItem, Person } from './common.tsx'
import { Icon } from './icons.tsx'

/** Фильтры живут в адресе (`#/list?q=…&status=open,inProgress&assignee=me`), ссылкой можно поделиться. */
export interface Filters {
  q: string
  assignee: string
  statuses: StatusKey[]
}

export function readFilters(query: URLSearchParams): Filters {
  const statuses = (query.get('status') ?? '')
    .split(',')
    .filter((key): key is StatusKey => (STATUS_ORDER as string[]).includes(key))
  return { q: query.get('q') ?? '', assignee: query.get('assignee') ?? '', statuses }
}

export function updateQuery(base: string, query: URLSearchParams, changes: Record<string, string | null>): void {
  const next = new URLSearchParams(query)
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  navigate(withQuery(base, next), { replace: true })
}

export function matchesFilters(issue: Issue, filters: Filters, viewer: string | null): boolean {
  if (filters.statuses.length && !filters.statuses.includes(issue.status)) return false
  if (filters.assignee === 'none' && issue.assignee) return false
  if (filters.assignee === 'me' && issue.assignee !== viewer) return false
  if (filters.assignee && !['none', 'me'].includes(filters.assignee) && issue.assignee !== filters.assignee) return false
  const q = filters.q.trim().toLowerCase()
  if (!q) return true
  return [issue.key, issue.title, issue.body.description, displayName(issue.assignee)].some((text) =>
    text.toLowerCase().includes(q),
  )
}

function assigneeLabel(value: string): string {
  if (value === 'me') return 'Я'
  if (value === 'none') return 'Без исполнителя'
  return value ? displayName(value) : 'Все исполнители'
}

/** Поиск с задержкой: адрес не дёргается на каждую букву. */
function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const timer = setTimeout(() => onChange(draft), 250)
    return () => clearTimeout(timer)
  }, [draft])
  return (
    <label class="search">
      <Icon name="search" />
      <input
        type="search"
        class="search__input"
        placeholder="Поиск по задачам"
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && onChange(draft)}
      />
    </label>
  )
}

export function FilterBar({
  base,
  query,
  filters,
  withStatus,
}: {
  base: string
  query: URLSearchParams
  filters: Filters
  withStatus: boolean
}) {
  const viewer = session.value?.viewer.login ?? null
  const people = [...users.value.values()].filter((user) => user.login !== viewer)
  const active = Boolean(filters.q || filters.assignee || filters.statuses.length)
  const toggleStatus = (key: StatusKey) => {
    const next = filters.statuses.includes(key) ? filters.statuses.filter((s) => s !== key) : [...filters.statuses, key]
    updateQuery(base, query, { status: next.length ? STATUS_ORDER.filter((s) => next.includes(s)).join(',') : null })
  }
  return (
    <div class="filters">
      <SearchInput value={filters.q} onChange={(q) => updateQuery(base, query, { q: q.trim() || null })} />
      {withStatus && (
        <Menu
          triggerClass={`btn btn--outlined${filters.statuses.length ? ' is-active' : ''}`}
          label={
            <>
              {filters.statuses.length ? filters.statuses.map((key) => STATUSES[key].title).join(', ') : 'Все статусы'}
              <Icon name="chevronDown" size={14} />
            </>
          }
        >
          {() =>
            STATUS_ORDER.map((key) => (
              <MenuItem key={key} selected={filters.statuses.includes(key)} onSelect={() => toggleStatus(key)}>
                <span class={`dot dot--${STATUSES[key].tone}`} />
                {STATUSES[key].title}
              </MenuItem>
            ))
          }
        </Menu>
      )}
      <Menu
        triggerClass={`btn btn--outlined${filters.assignee ? ' is-active' : ''}`}
        label={
          <>
            {assigneeLabel(filters.assignee)}
            <Icon name="chevronDown" size={14} />
          </>
        }
      >
        {(close) => {
          const pick = (value: string) => {
            close()
            updateQuery(base, query, { assignee: value || null })
          }
          return (
            <>
              <MenuItem selected={!filters.assignee} onSelect={() => pick('')}>
                Все исполнители
              </MenuItem>
              <MenuItem selected={filters.assignee === 'me'} onSelect={() => pick('me')}>
                <Person login={viewer} />
                <span class="menu__hint">это я</span>
              </MenuItem>
              {people.map((user) => (
                <MenuItem key={user.login} selected={filters.assignee === user.login} onSelect={() => pick(user.login)}>
                  <Person login={user.login} name={user.name} />
                </MenuItem>
              ))}
              <MenuItem selected={filters.assignee === 'none'} onSelect={() => pick('none')}>
                <span class="person person--empty">Без исполнителя</span>
              </MenuItem>
            </>
          )
        }}
      </Menu>
      {active && (
        <button type="button" class="btn btn--flat" onClick={() => updateQuery(base, query, { q: null, assignee: null, status: null })}>
          Сбросить
        </button>
      )}
    </div>
  )
}
