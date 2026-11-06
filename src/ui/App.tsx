import { useEffect } from 'preact/hooks'
import { APP_TITLE, KEY_PREFIX } from '../config.ts'
import { formatDateTime } from '../domain/format.ts'
import { route } from '../router.ts'
import { booting, dismissToast, issueMap, refresh, session, signOut, sync, toasts, unreadCount } from '../store.ts'
import { Board } from './Board.tsx'
import { Avatar, EmptyState, Menu, MenuItem, Spinner } from './common.tsx'
import { CreateIssue } from './CreateIssue.tsx'
import { forgetDrafts } from './drafts.ts'
import { Icon } from './icons.tsx'
import { IssueList } from './IssueList.tsx'
import { IssuePage } from './IssuePage.tsx'
import { Login } from './Login.tsx'
import { Lightbox } from './markdown.tsx'
import { Notifications } from './Notifications.tsx'

export function App() {
  if (booting.value) {
    return (
      <div class="splash">
        <Spinner size={24} />
      </div>
    )
  }
  if (!session.value) {
    return (
      <>
        <Login />
        <Toasts />
      </>
    )
  }
  return (
    <div class="app">
      <Header />
      {session.value.demo && (
        <div class="demo-banner">Демо-режим: задачи из выгрузки Трекера. Правки живут до перезагрузки страницы и никуда не уходят.</div>
      )}
      <main class="main">
        <Page />
      </main>
      <Lightbox />
      <Toasts />
    </div>
  )
}

function Page() {
  const current = route.value
  const issue = current.name === 'issue' ? issueMap.value.get(current.number) : undefined
  const unread = unreadCount.value
  useEffect(() => {
    const titles: Record<string, string> = {
      board: 'Доска',
      list: 'Задачи',
      notifications: 'Уведомления',
      new: 'Новая задача',
      notFound: 'Не найдено',
    }
    const title = current.name === 'issue' ? (issue ? `${issue.key}: ${issue.title}` : `${KEY_PREFIX}-${current.number}`) : titles[current.name]
    // счётчик во вкладке браузера: новое видно, даже когда трекер в фоне
    document.title = `${unread ? `(${unread}) ` : ''}${title} — ${APP_TITLE}`
  }, [current, issue?.title, unread])

  switch (current.name) {
    case 'board':
      return <Board query={current.query} />
    case 'list':
      return <IssueList query={current.query} />
    case 'issue':
      return <IssuePage number={current.number} tab={current.query.get('tab')} />
    case 'notifications':
      return <Notifications query={current.query} />
    case 'new':
      return <CreateIssue />
    case 'notFound':
      return (
        <div class="page">
          <EmptyState title="Такой страницы нет">
            <a href="#/board">На доску</a>
          </EmptyState>
        </div>
      )
  }
}

function Header() {
  const current = route.value
  const me = session.value!
  const state = sync.value
  const unread = unreadCount.value
  return (
    <header class="topbar">
      <a class="topbar__brand" href="#/board" title={APP_TITLE}>
        <img class="topbar__logo" src="./favicon.svg" alt="" width={24} height={24} />
        <span class="topbar__queue">{KEY_PREFIX}</span>
      </a>
      <nav class="tabs" aria-label="Разделы">
        <a class={`tabs__item${current.name === 'board' ? ' is-active' : ''}`} href="#/board">
          <Icon name="board" />
          <span>Доска</span>
        </a>
        <a class={`tabs__item${current.name === 'list' ? ' is-active' : ''}`} href="#/list">
          <Icon name="list" />
          <span>Список</span>
        </a>
      </nav>
      <span class="spacer" />
      <button
        type="button"
        class={`btn btn--icon sync${state.loading ? ' is-loading' : ''}${state.error ? ' is-error' : ''}`}
        title={state.error ? `Не удалось обновить: ${state.error}` : state.at ? `Обновлено: ${formatDateTime(new Date(state.at).toISOString())}` : 'Обновить'}
        onClick={() => void refresh()}
      >
        <Icon name="refresh" />
      </button>
      <a
        class={`btn btn--icon bell${current.name === 'notifications' ? ' is-active' : ''}`}
        href="#/notifications"
        title={unread ? `Уведомления: новых ${unread}` : 'Уведомления'}
        aria-label={unread ? `Уведомления, новых: ${unread}` : 'Уведомления'}
      >
        <Icon name="bell" />
        {unread > 0 && <span class="bell__badge">{unread > 99 ? '99+' : unread}</span>}
      </a>
      <a class="btn btn--action topbar__create" href="#/new" title="Создать задачу">
        <Icon name="plus" />
        <span class="hide-mobile">Создать задачу</span>
      </a>
      <Menu triggerClass="btn btn--icon topbar__user" align="end" title={me.viewer.name || me.viewer.login} label={<Avatar login={me.viewer.login} name={me.viewer.name} />}>
        {(close) => (
          <>
            <div class="menu__header">
              <b>{me.viewer.name || me.viewer.login}</b>
              <span class="muted">{me.viewer.login}</span>
              <span class="muted small">
                {me.repo.owner}/{me.repo.name}
              </span>
            </div>
            {!me.demo && (
              <MenuItem
                danger
                onSelect={() => {
                  close()
                  forgetDrafts()
                  signOut()
                }}
              >
                <Icon name="logout" />
                Выйти
              </MenuItem>
            )}
          </>
        )}
      </Menu>
    </header>
  )
}

function Toasts() {
  if (!toasts.value.length) return null
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((toast) => (
        <div key={toast.id} class={`toast toast--${toast.tone}`}>
          <span>{toast.text}</span>
          <button type="button" class="btn btn--icon btn--s" aria-label="Закрыть" onClick={() => dismissToast(toast.id)}>
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  )
}
