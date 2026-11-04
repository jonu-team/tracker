import { checklistProgress } from '../domain/body.ts'
import { pluralize } from '../domain/format.ts'
import type { Issue } from '../domain/issue.ts'
import { STATUS_ORDER } from '../domain/status.ts'
import { issueHref, navigate } from '../router.ts'
import { displayName, issues, session } from '../store.ts'
import { DateText, EmptyState, Menu, MenuItem, Person, StatusLabel } from './common.tsx'
import { FilterBar, matchesFilters, readFilters, updateQuery } from './filters.tsx'
import { Icon } from './icons.tsx'

type SortKey = 'key' | 'title' | 'status' | 'assignee' | 'updated'
type Direction = 'asc' | 'desc'

const COLUMNS: { key: SortKey; title: string; defaultDirection: Direction }[] = [
  { key: 'key', title: 'Ключ', defaultDirection: 'desc' },
  { key: 'title', title: 'Задача', defaultDirection: 'asc' },
  { key: 'status', title: 'Статус', defaultDirection: 'asc' },
  { key: 'assignee', title: 'Исполнитель', defaultDirection: 'asc' },
  { key: 'updated', title: 'Обновлена', defaultDirection: 'desc' },
]

function compare(sort: SortKey): (a: Issue, b: Issue) => number {
  switch (sort) {
    case 'key':
      return (a, b) => a.number - b.number
    case 'title':
      return (a, b) => a.title.localeCompare(b.title, 'ru')
    case 'status':
      return (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    case 'assignee':
      // без исполнителя — в конце при любом направлении сортировки
      return (a, b) => displayName(a.assignee).localeCompare(displayName(b.assignee), 'ru')
    case 'updated':
      return (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
  }
}

export function IssueList({ query }: { query: URLSearchParams }) {
  const filters = readFilters(query)
  const viewer = session.value?.viewer.login ?? null
  const column = COLUMNS.find((candidate) => candidate.key === query.get('sort')) ?? COLUMNS[4]!
  const direction: Direction = query.get('dir') === 'asc' || query.get('dir') === 'desc' ? (query.get('dir') as Direction) : column.defaultDirection
  const sign = direction === 'asc' ? 1 : -1
  const order = compare(column.key)
  const rows = issues.value
    .filter((issue) => matchesFilters(issue, filters, viewer))
    .sort((a, b) => {
      if (column.key === 'assignee' && Boolean(a.assignee) !== Boolean(b.assignee)) return a.assignee ? -1 : 1
      return sign * order(a, b) || b.number - a.number
    })

  const sortBy = (key: SortKey) => {
    const next = COLUMNS.find((candidate) => candidate.key === key)!
    const dir = key === column.key ? (direction === 'asc' ? 'desc' : 'asc') : next.defaultDirection
    updateQuery('/list', query, { sort: key === 'updated' ? null : key, dir: dir === next.defaultDirection ? null : dir })
  }

  return (
    <div class="page page--list">
      <div class="page__head">
        <h1 class="page__title">
          Задачи <span class="page__count">{rows.length}</span>
        </h1>
        <FilterBar base="/list" query={query} filters={filters} withStatus />
        <Menu
          triggerClass="btn btn--outlined show-mobile"
          align="end"
          label={
            <>
              {column.title}
              <Icon name="chevronDown" size={14} class={direction === 'asc' ? 'is-flipped' : ''} />
            </>
          }
        >
          {(close) =>
            COLUMNS.map((candidate) => (
              <MenuItem key={candidate.key} selected={candidate.key === column.key} onSelect={() => (close(), sortBy(candidate.key))}>
                {candidate.title}
              </MenuItem>
            ))
          }
        </Menu>
      </div>
      {rows.length ? (
        <table class="table">
          <thead>
            <tr>
              {COLUMNS.map((candidate) => (
                <th key={candidate.key} class={`col-${candidate.key}`} aria-sort={candidate.key === column.key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                  <button type="button" class="sort-button" onClick={() => sortBy(candidate.key)}>
                    {candidate.title}
                    {candidate.key === column.key && <Icon name="chevronDown" size={14} class={direction === 'asc' ? 'is-flipped' : ''} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((issue) => (
              <Row key={issue.number} issue={issue} />
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title={issues.value.length ? 'Ничего не нашлось' : 'Задач пока нет'}>
          {issues.value.length ? 'Попробуйте изменить фильтры.' : 'Создайте первую задачу.'}
        </EmptyState>
      )}
      {rows.length > 0 && <div class="page__foot muted">{pluralize(rows.length, ['задача', 'задачи', 'задач'])}</div>}
    </div>
  )
}

function Row({ issue }: { issue: Issue }) {
  const progress = checklistProgress(issue.body.checklist)
  const href = issueHref(issue.number)
  return (
    <tr
      class="row"
      onClick={(event) => {
        if ((event.target as Element).closest('a, button') || getSelection()?.toString()) return
        navigate(href)
      }}
    >
      <td class="col-key">
        <a class="key" href={href}>
          {issue.key}
        </a>
      </td>
      <td class="col-title">
        <a class="row__title" href={href}>
          {issue.title}
        </a>
        <span class="row__meta">
          {issue.milestone && (
            <span class="tag tag--milestone">
              <Icon name="flag" size={12} />
              Веха
            </span>
          )}
          {progress.total > 0 && (
            <span class="card__meta" title="Чеклист">
              <Icon name="checklist" size={14} />
              {progress.done}/{progress.total}
            </span>
          )}
          {issue.comments > 0 && (
            <span class="card__meta" title="Комментарии">
              <Icon name="comment" size={14} />
              {issue.comments}
            </span>
          )}
        </span>
      </td>
      <td class="col-status">
        <StatusLabel status={issue.status} size="s" />
      </td>
      <td class="col-assignee">
        <Person login={issue.assignee} empty="—" />
      </td>
      <td class="col-updated">
        <DateText iso={issue.updatedAt} />
      </td>
    </tr>
  )
}
