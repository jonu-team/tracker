import { useEffect, useRef, useState } from 'preact/hooks'
import { STATUSES, type StatusKey } from '../domain/status.ts'
import { issueHref, navigate } from '../router.ts'
import { createIssue } from '../store.ts'
import { Menu, MenuItem, UserPicker } from './common.tsx'
import { Icon } from './icons.tsx'
import { MarkdownEditor } from './markdown.tsx'

const START_STATUSES: StatusKey[] = ['open', 'inProgress', 'needInfo']

export function CreateIssue() {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<StatusKey>('open')
  const [assignee, setAssignee] = useState<string | null>(null)
  const [milestone, setMilestone] = useState(false)
  const [busy, setBusy] = useState(false)
  const titleInput = useRef<HTMLInputElement>(null)
  useEffect(() => titleInput.current?.focus(), [])

  const submit = async (event?: Event) => {
    event?.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    const number = await createIssue({ title, description: description.trim(), status, assignee, milestone })
    setBusy(false)
    if (number) navigate(issueHref(number), { replace: true })
  }

  return (
    <div class="page page--create">
      <h1 class="page__title">Новая задача</h1>
      <form class="create" onSubmit={submit}>
        <input
          class="input input--title"
          placeholder="Название задачи"
          value={title}
          maxLength={256}
          required
          ref={titleInput}
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
        <MarkdownEditor
          value={description}
          onInput={setDescription}
          issueNumber={null}
          minRows={8}
          placeholder="Описание: что нужно сделать, зачем и как проверить"
          onSubmit={() => void submit()}
        />
        <div class="create__fields">
          <div class="field">
            <div class="field__label">Статус</div>
            <Menu
              triggerClass={`status-button label label--${STATUSES[status].tone}`}
              label={
                <>
                  {STATUSES[status].title}
                  <Icon name="chevronDown" size={14} />
                </>
              }
            >
              {(close) =>
                START_STATUSES.map((key) => (
                  <MenuItem key={key} selected={key === status} onSelect={() => (close(), setStatus(key))}>
                    <span class={`dot dot--${STATUSES[key].tone}`} />
                    {STATUSES[key].title}
                  </MenuItem>
                ))
              }
            </Menu>
          </div>
          <div class="field">
            <div class="field__label">Исполнитель</div>
            <UserPicker value={assignee} onChange={setAssignee} />
          </div>
          <div class="field">
            <div class="field__label">Тип</div>
            <Menu triggerClass="btn btn--flat btn--field" label={milestone ? 'Веха' : 'Задача'}>
              {(close) => (
                <>
                  <MenuItem selected={!milestone} onSelect={() => (close(), setMilestone(false))}>
                    Задача
                  </MenuItem>
                  <MenuItem selected={milestone} onSelect={() => (close(), setMilestone(true))}>
                    <Icon name="flag" />
                    Веха
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn--action btn--l" disabled={!title.trim() || busy}>
            {busy ? 'Создаю…' : 'Создать задачу'}
          </button>
          <a class="btn btn--flat btn--l" href="#/board">
            Отмена
          </a>
        </div>
      </form>
    </div>
  )
}
