import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { withoutComments, type ActivityEntry, type Change } from '../domain/activity.ts'
import { diffLines, withContext } from '../domain/diff.ts'
import { formatDue, pluralize } from '../domain/format.ts'
import type { Issue, Person as PersonInfo } from '../domain/issue.ts'
import { issueHref } from '../router.ts'
import { activityByIssue, displayName, issueMap, loadHistory } from '../store.ts'
import { Avatar, DateText, Person, Spinner, StatusLabel } from './common.tsx'
import { Markdown } from './markdown.tsx'

/**
 * Изменения задачи — в истории задачи и в уведомлениях. В уведомлениях
 * (`compact`) запись целиком — ссылка на задачу, поэтому внутри нет ни ссылок,
 * ни кнопок, а тексты пунктов показываются без разметки.
 */

const FIELDS: Record<Change['kind'], string> = {
  created: 'Задача',
  createdInTracker: 'Задача',
  migrated: 'Задача',
  title: 'Название',
  status: 'Статус',
  assignee: 'Исполнитель',
  milestone: 'Тип',
  label: 'Метка',
  description: 'Описание',
  itemAdded: 'Чеклист',
  itemRemoved: 'Чеклист',
  itemChecked: 'Чеклист',
  itemText: 'Чеклист',
  itemAssignee: 'Чеклист',
  itemDue: 'Чеклист',
  itemsReordered: 'Чеклист',
  link: 'Связи',
  attachment: 'Вложения',
  comment: 'Комментарий',
}

export function actorName(actor: PersonInfo): string {
  return actor.name || displayName(actor.login) || 'Удалённый аккаунт'
}

export function ChangeRow({ change, compact = false }: { change: Change; compact?: boolean }) {
  if (change.kind === 'description' && !compact) return <DescriptionRow from={change.from} to={change.to} />
  return (
    <li class="change">
      <span class="change__field">{FIELDS[change.kind]}</span>
      <span class="change__value">
        <ChangeValue change={change} compact={compact} />
      </span>
    </li>
  )
}

function ChangeValue({ change, compact }: { change: Change; compact: boolean }) {
  const item = (text: string, removed = false) => (
    <q class={removed ? 'change__old' : undefined}>{compact ? plainText(text) : <Markdown inline text={text} />}</q>
  )
  switch (change.kind) {
    case 'created':
      return <>создана</>
    case 'createdInTracker':
      return <>создана в Яндекс Трекере</>
    case 'migrated':
      return <>перенесена из Яндекс Трекера</>
    case 'title':
      return <FromTo from={<q class="change__old">{change.from}</q>} to={<q>{change.to}</q>} />
    case 'status':
      return <FromTo from={change.from && <StatusLabel status={change.from} size="s" />} to={<StatusLabel status={change.to} size="s" />} />
    case 'assignee':
      return (
        <FromTo
          from={change.from !== undefined && <Person login={change.from} empty="не назначен" />}
          to={<Person login={change.to} empty="не назначен" />}
        />
      )
    case 'milestone':
      return <FromTo from={change.from !== undefined && (change.from ? 'Веха' : 'Задача')} to={change.to ? 'Веха' : 'Задача'} />
    case 'label':
      return (
        <>
          <span class="tag">{change.name}</span> {change.added ? 'добавлена' : 'снята'}
        </>
      )
    case 'description':
      return <>{descriptionVerb(change.from, change.to)}</>
    case 'itemAdded':
      return <>{item(change.text)} — добавлен</>
    case 'itemRemoved':
      return <>{item(change.text, true)} — удалён</>
    case 'itemChecked':
      return <>{item(change.text)} — {change.checked ? 'выполнен' : 'снова не выполнен'}</>
    case 'itemText':
      return <FromTo from={item(change.from, true)} to={item(change.to)} />
    case 'itemAssignee':
      return (
        <>
          {item(change.text)} — исполнитель{' '}
          <FromTo
            from={<Person login={change.from} empty="не назначен" />}
            to={<Person login={change.to} empty="не назначен" />}
          />
        </>
      )
    case 'itemDue':
      return (
        <>
          {item(change.text)} —{' '}
          {change.to ? (
            <>
              срок <FromTo from={change.from && formatDue(change.from)} to={formatDue(change.to)} />
            </>
          ) : (
            'срок снят'
          )}
        </>
      )
    case 'itemsReordered':
      return <>порядок пунктов изменён</>
    case 'link':
      return (
        <>
          <IssueRef number={change.number} compact={compact} /> {change.added ? 'добавлена' : 'убрана'}
        </>
      )
    case 'attachment':
      return (
        <>
          <q>{change.name}</q> {change.added ? 'прикреплён' : 'убран'}
        </>
      )
    case 'comment':
      return <span class="change__excerpt">{commentExcerpt(change.text)}</span>
  }
}

function FromTo({ from, to }: { from?: ComponentChildren; to: ComponentChildren }) {
  return (
    <>
      {from !== undefined && from !== false && from !== null && from !== '' && (
        <>
          {from}
          <span class="change__arrow" aria-label="стало">
            →
          </span>
        </>
      )}
      {to}
    </>
  )
}

function IssueRef({ number, compact }: { number: number; compact: boolean }) {
  const linked = issueMap.value.get(number)
  const key = linked?.key ?? `#${number}`
  return (
    <>
      {compact ? <span class="key">{key}</span> : <a class="key" href={issueHref(number)}>{key}</a>}
      {linked && <span class="change__issue-title">{linked.title}</span>}
    </>
  )
}

function descriptionVerb(from: string, to: string): string {
  if (!from) return 'добавлено'
  if (!to) return 'удалено'
  return 'изменено'
}

/** Описание в истории: что стало, и по кнопке — построчная разница. */
function DescriptionRow({ from, to }: { from: string; to: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li class="change">
      <span class="change__field">{FIELDS.description}</span>
      <span class="change__value">
        {descriptionVerb(from, to)}
        <button type="button" class="btn btn--flat btn--s" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Скрыть изменения' : 'Показать изменения'}
        </button>
      </span>
      {open && <DescriptionDiff from={from} to={to} />}
    </li>
  )
}

function DescriptionDiff({ from, to }: { from: string; to: string }) {
  const rows = withContext(diffLines(from, to))
  return (
    <div class="diff">
      {rows.map((row, index) =>
        row.type === 'skip' ? (
          <div key={index} class="diff__skip">
            {pluralize(row.count, ['строка', 'строки', 'строк'])} без изменений
          </div>
        ) : (
          <div key={index} class={`diff__line diff__line--${row.type}`}>
            <span class="diff__sign">{row.type === 'added' ? '+' : row.type === 'removed' ? '−' : ''}</span>
            <span class="diff__text">{row.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  )
}

/** Markdown пункта или комментария — простым текстом: ссылки и выделение без разметки. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[((?:[^\[\]\\]|\\.)*)\]\([^)\s]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Начало комментария без цитат: в уведомлении важен ответ, а не то, на что отвечают. */
function commentExcerpt(text: string): string {
  const own = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
  return plainText(own) || plainText(text)
}

// История задачи

export function History({ issue }: { issue: Issue }) {
  const state = activityByIssue.value.get(issue.number)
  // Задача изменилась (своей правкой или при обновлении) — история подтянется.
  useEffect(() => {
    void loadHistory(issue.number)
  }, [issue.number, issue.raw.updated_at])

  if (!state || state.status === 'loading') return <Spinner />
  if (state.status === 'error') {
    return (
      <div class="alert alert--error">
        История не загрузилась: {state.error}{' '}
        <button type="button" class="btn btn--flat btn--s" onClick={() => void loadHistory(issue.number)}>
          Повторить
        </button>
      </div>
    )
  }
  const entries = withoutComments(state.history.entries)
  return (
    <>
      <ul class="entries">
        {entries.map((entry) => (
          <HistoryEntry key={entry.id} entry={entry} />
        ))}
      </ul>
      {state.history.truncated && (
        <p class="muted small">
          Показаны последние изменения. Полная история —{' '}
          <a href={issue.url} target="_blank" rel="noopener noreferrer">
            в GitHub
          </a>
          .
        </p>
      )}
    </>
  )
}

function HistoryEntry({ entry }: { entry: ActivityEntry }) {
  return (
    <li class="entry">
      <Avatar login={entry.actor.login} name={entry.actor.name} />
      <div class="entry__body">
        <div class="entry__head">
          <span class="entry__who">{actorName(entry.actor)}</span>
          <DateText iso={entry.at} />
        </div>
        <ul class="changes">
          {entry.changes.map((change, index) => (
            <ChangeRow key={index} change={change} />
          ))}
        </ul>
      </div>
    </li>
  )
}
