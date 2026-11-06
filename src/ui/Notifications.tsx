import { useEffect, useState } from 'preact/hooks'
import { KEY_PREFIX } from '../config.ts'
import type { ActivityEntry } from '../domain/activity.ts'
import { formatDay, formatDateTime, formatTime, pluralize } from '../domain/format.ts'
import { issueHref, navigate, withQuery } from '../router.ts'
import { FEED_DAYS, feed, feedEntries, issueMap, markFeedSeen, refresh, seenAt, session } from '../store.ts'
import { ChangeRow, actorName } from './activity.tsx'
import { Avatar, EmptyState, Spinner } from './common.tsx'

/**
 * Уведомления: что меняли в задачах за последние FEED_DAYS дней. «Входящие» —
 * правки других участников, «Мои» — ваши правки, то есть то, что другие видят
 * у себя во «Входящих».
 */

/** Сколько изменений показать в карточке; остальные — в истории задачи. */
const CARD_CHANGES = 4

export function Notifications({ query }: { query: URLSearchParams }) {
  const me = session.value!.viewer.login
  const mine = query.get('view') === 'mine'
  const state = feed.value
  const all = feedEntries.value
  // Новое подсвечено по отметке на момент открытия, а счётчик в шапке гаснет сразу.
  const [seenOnOpen] = useState(() => seenAt.value)
  useEffect(() => markFeedSeen(), [all])

  const entries = all.filter((entry) => (entry.actor.login === me) === mine)
  const unread = mine ? 0 : entries.filter((entry) => Date.parse(entry.at) > seenOnOpen).length
  const show = (view: 'incoming' | 'mine') =>
    navigate(withQuery('#/notifications', new URLSearchParams(view === 'mine' ? { view: 'mine' } : {})), { replace: true })

  return (
    <div class="page page--feed">
      <div class="page__head">
        <h1 class="page__title">Уведомления</h1>
        <div class="segmented" role="tablist" aria-label="Чьи изменения">
          <button type="button" role="tab" aria-selected={!mine} class={mine ? '' : 'is-active'} onClick={() => show('incoming')}>
            Входящие{unread > 0 && ` · ${unread}`}
          </button>
          <button type="button" role="tab" aria-selected={mine} class={mine ? 'is-active' : ''} onClick={() => show('mine')}>
            Мои
          </button>
        </div>
      </div>
      <p class="feed-lead muted">
        {mine
          ? `Ваши изменения за ${pluralize(FEED_DAYS, ['день', 'дня', 'дней'])}. Их видят другие участники у себя во «Входящих».`
          : `Что меняли в задачах другие участники за ${pluralize(FEED_DAYS, ['день', 'дня', 'дней'])}.`}
      </p>

      {state.status === 'error' && (
        <div class="alert alert--error">
          Уведомления не загрузились: {state.error}{' '}
          <button type="button" class="btn btn--flat btn--s" onClick={() => void refresh()}>
            Повторить
          </button>
        </div>
      )}
      {(state.status === 'loading' || state.status === 'idle') && !entries.length && <Spinner />}
      {state.status === 'ready' && !entries.length && (
        <EmptyState title={mine ? 'Вы ничего не меняли' : 'Других изменений не было'}>
          Изменения старше {pluralize(FEED_DAYS, ['дня', 'дней', 'дней'])} — во вкладке «История» каждой задачи.
        </EmptyState>
      )}

      {byDay(entries).map((group) => (
        <section key={group.day} class="feed-day">
          <h2 class="feed-day__title">{group.day}</h2>
          <ul class="feed">
            {group.entries.map((entry) => (
              <FeedItem key={entry.id} entry={entry} unread={!mine && Date.parse(entry.at) > seenOnOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function FeedItem({ entry, unread }: { entry: ActivityEntry; unread: boolean }) {
  const issue = issueMap.value.get(entry.issue)
  // Карточка без комментариев ведёт сразу на вкладку «История».
  const toHistory = !entry.changes.some((change) => change.kind === 'comment')
  const href = toHistory ? withQuery(issueHref(entry.issue), new URLSearchParams({ tab: 'history' })) : issueHref(entry.issue)
  const hidden = entry.changes.length - CARD_CHANGES
  return (
    <li>
      <a class={`feed-item${unread ? ' is-unread' : ''}`} href={href}>
        <Avatar login={entry.actor.login} name={entry.actor.name} />
        <div class="feed-item__body">
          <div class="feed-item__head">
            <span class="feed-item__who">{actorName(entry.actor)}</span>
            <span class="key">{issue?.key ?? `${KEY_PREFIX}-${entry.issue}`}</span>
            {issue && <span class="feed-item__title">{issue.title}</span>}
            <time class="feed-item__time" dateTime={entry.at} title={formatDateTime(entry.at)}>
              {formatTime(entry.at)}
            </time>
            {unread && <span class="feed-item__dot" title="Новое" />}
          </div>
          <ul class="changes">
            {entry.changes.slice(0, CARD_CHANGES).map((change, index) => (
              <ChangeRow key={index} change={change} compact />
            ))}
          </ul>
          {hidden > 0 && <div class="feed-item__more">и ещё {pluralize(hidden, ['изменение', 'изменения', 'изменений'])}</div>}
        </div>
      </a>
    </li>
  )
}

function byDay(entries: ActivityEntry[]): { day: string; entries: ActivityEntry[] }[] {
  const groups: { day: string; entries: ActivityEntry[] }[] = []
  for (const entry of entries) {
    const day = formatDay(entry.at)
    const last = groups.at(-1)
    if (last?.day === day) last.entries.push(entry)
    else groups.push({ day, entries: [entry] })
  }
  return groups
}
