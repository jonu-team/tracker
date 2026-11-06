import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { KEY_PREFIX } from '../config.ts'
import { parseBody } from '../domain/body.ts'
import { setDescription } from '../domain/edits.ts'
import type { Issue } from '../domain/issue.ts'
import { issueHref, navigate, withQuery } from '../router.ts'
import { changeBody, issueMap, notify, savingIssues, session, setAssignee, setMilestone, setStatus, setTitle } from '../store.ts'
import { History } from './activity.tsx'
import { DateText, EmptyState, Menu, MenuItem, Person, Spinner, StatusButton, UserPicker } from './common.tsx'
import { composerFocus } from './drafts.ts'
import { Icon } from './icons.tsx'
import { AttachButton, AttachmentsBlock, ChecklistBlock, Comments, LinksBlock } from './issue-blocks.tsx'
import { Markdown, MarkdownEditor } from './markdown.tsx'
import { QuoteReply } from './QuoteReply.tsx'

export function IssuePage({ number, tab }: { number: number; tab: string | null }) {
  const issue = issueMap.value.get(number)
  const [addChecklist, setAddChecklist] = useState(false)
  const [addLink, setAddLink] = useState(false)
  useEffect(() => {
    setAddChecklist(false)
    setAddLink(false)
    window.scrollTo(0, 0)
  }, [number])

  if (!issue) {
    return (
      <div class="page">
        <EmptyState title={`Задачи ${KEY_PREFIX}-${number} нет`}>
          Возможно, её ещё не создали или у токена нет к ней доступа. <a href="#/list">К списку задач</a>
        </EmptyState>
      </div>
    )
  }

  const saving = savingIssues.value.has(number)
  const hasChecklist = issue.body.checklist.length > 0 || addChecklist
  const hasLinks = issue.body.links.length > 0 || addLink

  return (
    <div class="page page--issue">
      <QuoteReply issueNumber={number} />
      <div class="crumbs">
        <a href="#/list">{KEY_PREFIX}</a>
        <span class="crumbs__sep">/</span>
        <span class="crumbs__key">{issue.key}</span>
        <button
          type="button"
          class="btn btn--icon btn--s"
          title="Скопировать ссылку"
          onClick={() => navigator.clipboard.writeText(location.href).then(() => notify('Ссылка скопирована'))}
        >
          <Icon name="copy" />
        </button>
        <a class="btn btn--flat btn--s" href={issue.url} target="_blank" rel="noopener noreferrer" title="Открыть issue в GitHub">
          <Icon name="github" />
          <span class="hide-mobile">GitHub</span>
        </a>
        {saving && <Spinner size={14} />}
      </div>

      <Title issue={issue} />

      <div class="issue">
        <div class="issue__main">
          <Description issue={issue} />
          {(!hasChecklist || !hasLinks || !issue.body.attachments.length) && (
            <div class="add-bar">
              {!hasChecklist && (
                <button type="button" class="btn btn--outlined btn--s" onClick={() => setAddChecklist(true)}>
                  <Icon name="checklist" />
                  Чеклист
                </button>
              )}
              {!hasLinks && (
                <button type="button" class="btn btn--outlined btn--s" onClick={() => setAddLink(true)}>
                  <Icon name="link" />
                  Связь
                </button>
              )}
              {!issue.body.attachments.length && (
                <AttachButton issue={issue} class="btn btn--outlined btn--s">
                  <Icon name="paperclip" />
                  Файл
                </AttachButton>
              )}
            </div>
          )}
          <ChecklistBlock issue={issue} adding={addChecklist} onAdded={() => setAddChecklist(false)} />
          <LinksBlock issue={issue} adding={addLink} onAdded={() => setAddLink(false)} />
          <AttachmentsBlock issue={issue} />
          <ActivityTabs issue={issue} tab={tab === 'history' ? 'history' : 'comments'} />
        </div>

        <aside class="issue__side">
          <Field label="Статус">
            <StatusButton status={issue.status} onChange={(next) => void setStatus(number, next)} />
          </Field>
          <Field label="Исполнитель">
            <UserPicker value={issue.assignee} onChange={(login) => void setAssignee(number, login)} />
          </Field>
          <Field label="Тип">
            <Menu
              triggerClass="btn btn--flat btn--field"
              label={
                <>
                  {issue.milestone && <Icon name="flag" />}
                  {issue.milestone ? 'Веха' : 'Задача'}
                </>
              }
            >
              {(close) => (
                <>
                  <MenuItem selected={!issue.milestone} onSelect={() => (close(), issue.milestone && void setMilestone(number, false))}>
                    Задача
                  </MenuItem>
                  <MenuItem selected={issue.milestone} onSelect={() => (close(), !issue.milestone && void setMilestone(number, true))}>
                    <Icon name="flag" />
                    Веха
                  </MenuItem>
                </>
              )}
            </Menu>
          </Field>
          <Field label="Автор">
            <Person login={issue.author.login} name={issue.author.name} />
          </Field>
          <Field label="Создана">
            <DateText iso={issue.createdAt} />
          </Field>
          <Field label="Обновлена">
            <DateText iso={issue.updatedAt} />
          </Field>
        </aside>
      </div>
    </div>
  )
}

type ActivityTab = 'comments' | 'history'

/**
 * Комментарии и история — вкладками, как в Трекере. Вкладка записана в адресе
 * (`?tab=history`), поэтому ссылка из уведомлений открывает сразу историю.
 * Комментарии не размонтируются: цитата из описания, сделанная на вкладке
 * истории, сразу открывает поле комментария с черновиком и фокусом.
 */
function ActivityTabs({ issue, tab }: { issue: Issue; tab: ActivityTab }) {
  const quoteSeen = useRef(composerFocus.value)
  const quoted = composerFocus.value !== quoteSeen.current
  const active: ActivityTab = quoted ? 'comments' : tab
  const select = (next: ActivityTab) => {
    quoteSeen.current = composerFocus.value
    const query = new URLSearchParams(next === 'history' ? { tab: 'history' } : {})
    navigate(withQuery(issueHref(issue.number), query), { replace: true })
  }
  useEffect(() => {
    if (quoted && tab === 'history') select('comments')
  }, [quoted, tab])

  const tabButton = (key: ActivityTab, children: ComponentChildren) => (
    <button
      type="button"
      role="tab"
      aria-selected={active === key}
      class={`block-tab${active === key ? ' is-active' : ''}`}
      onClick={() => active !== key && select(key)}
    >
      {children}
    </button>
  )
  return (
    <section class="block">
      <div class="block__head block-tabs" role="tablist">
        {tabButton(
          'comments',
          <>
            Комментарии
            {issue.comments > 0 && <span class="block__counter">{issue.comments}</span>}
          </>,
        )}
        {tabButton('history', 'История')}
      </div>
      <div role="tabpanel" hidden={active !== 'comments'}>
        <Comments issue={issue} />
      </div>
      {active === 'history' && (
        <div role="tabpanel">
          <History issue={issue} />
        </div>
      )}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="field">
      <div class="field__label">{label}</div>
      <div class="field__value">{children}</div>
    </div>
  )
}

function Title({ issue }: { issue: Issue }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(issue.title)
  const save = () => {
    const title = draft.trim()
    setEditing(false)
    if (title && title !== issue.title) void setTitle(issue.number, title)
  }
  if (editing) {
    return (
      <textarea
        class="issue-title issue-title--edit"
        value={draft}
        rows={1}
        maxLength={256}
        ref={(el) => {
          if (el && document.activeElement !== el) {
            el.focus()
            el.style.height = `${el.scrollHeight}px`
          }
        }}
        onInput={(event) => {
          const el = event.currentTarget
          setDraft(el.value.replace(/\n/g, ' '))
          el.style.height = 'auto'
          el.style.height = `${el.scrollHeight}px`
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.preventDefault(), save())
          if (event.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <h1 class="issue-title" title="Нажмите, чтобы изменить" onClick={() => (setDraft(issue.title), setEditing(true))}>
      {issue.title}
      {issue.milestone && (
        <span class="tag tag--milestone">
          <Icon name="flag" size={12} />
          Веха
        </span>
      )}
    </h1>
  )
}

function Description({ issue }: { issue: Issue }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const text = issue.body.description

  const start = () => {
    setDraft(text)
    setBase(text)
    setEditing(true)
  }
  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      // Сосед мог поправить описание, пока его редактировали здесь.
      const fresh = parseBody((await session.value!.client.issue(issue.number)).body).description
      if (fresh !== base && !confirm('Пока вы редактировали, описание изменили. Сохранить вашу версию поверх?')) return
      if (await changeBody(issue.number, setDescription(draft.trim()))) setEditing(false)
    } catch {
      notify('Не удалось проверить свежую версию описания — попробуйте ещё раз.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="block block--description">
      <div class="block__head">
        <h2 class="block__title">Описание</h2>
        <span class="spacer" />
        {!editing && (
          <button type="button" class="btn btn--flat btn--s" onClick={start}>
            <Icon name="edit" />
            {text ? 'Изменить' : 'Добавить'}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <MarkdownEditor
            value={draft}
            onInput={setDraft}
            issueNumber={issue.number}
            autoFocus
            minRows={8}
            placeholder="Что нужно сделать, зачем и как проверить"
            onSubmit={save}
            onCancel={() => setEditing(false)}
          />
          <div class="form-actions">
            <button type="button" class="btn btn--action" disabled={busy} onClick={save}>
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </button>
            <button type="button" class="btn btn--flat" onClick={() => setEditing(false)}>
              Отмена
            </button>
          </div>
        </>
      ) : text ? (
        <Markdown text={text} quotable />
      ) : (
        <button type="button" class="placeholder" onClick={start}>
          Описания нет — нажмите, чтобы добавить
        </button>
      )}
    </section>
  )
}
