import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { checklistProgress, isImageName, newItemId, type Attachment, type ChecklistItem } from '../domain/body.ts'
import { addAttachment, addItem, itemRef, removeAttachment, removeItem, updateItem } from '../domain/edits.ts'
import { formatDue, isOverdue } from '../domain/format.ts'
import type { Comment, Issue } from '../domain/issue.ts'
import { loadRepoFile, repoFileFromUrl } from '../lib/files.ts'
import { issueHref } from '../router.ts'
import {
  addComment,
  changeBody,
  commentsByIssue,
  deleteComment,
  editComment,
  issueMap,
  issues,
  linkIssues,
  loadComments,
  session,
  uploadFile,
} from '../store.ts'
import { Avatar, DateText, Menu, MenuItem, Person, Spinner, StatusLabel, UserPicker } from './common.tsx'
import { Icon } from './icons.tsx'
import { Markdown, MarkdownEditor, lightbox } from './markdown.tsx'

// Чеклист

export function ChecklistBlock({ issue, adding, onAdded }: { issue: Issue; adding: boolean; onAdded: () => void }) {
  const items = issue.body.checklist
  const [hideDone, setHideDone] = useState(false)
  if (!items.length && !adding) return null
  const progress = checklistProgress(items)
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <section class="block">
      <div class="block__head">
        <h2 class="block__title">Чеклист</h2>
        {progress.total > 0 && (
          <span class="block__counter">
            {progress.done} из {progress.total}
          </span>
        )}
        <span class="spacer" />
        {progress.done > 0 && (
          <button type="button" class="btn btn--flat btn--s" onClick={() => setHideDone(!hideDone)}>
            {hideDone ? 'Показать выполненные' : 'Скрыть выполненные'}
          </button>
        )}
      </div>
      {progress.total > 0 && (
        <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <div class={`progress__bar${percent === 100 ? ' is-done' : ''}`} style={{ width: `${percent}%` }} />
        </div>
      )}
      <ul class="checklist">
        {items.map((item, index) =>
          hideDone && item.checked ? null : <ChecklistRow key={item.id || `${index}:${item.text}`} issue={issue} item={item} index={index} />,
        )}
      </ul>
      <AddChecklistItem issue={issue} autoFocus={adding} onDone={onAdded} />
    </section>
  )
}

function ChecklistRow({ issue, item, index }: { issue: Issue; item: ChecklistItem; index: number }) {
  const ref = itemRef(item, index)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const save = () => {
    setEditing(false)
    const text = draft.trim()
    if (text && text !== item.text) void changeBody(issue.number, updateItem(ref, { text }))
  }
  const overdue = item.due && !item.checked && isOverdue(item.due)
  return (
    <li class={`checklist__item${item.checked ? ' is-checked' : ''}`}>
      <label class="checkbox" title={item.checked ? 'Снять отметку' : 'Отметить выполненным'}>
        <input
          type="checkbox"
          checked={item.checked}
          aria-label={item.text}
          onChange={(event) => void changeBody(issue.number, updateItem(ref, { checked: event.currentTarget.checked }))}
        />
        <span class="checkbox__box">
          <Icon name="check" size={12} />
        </span>
      </label>
      {editing ? (
        <input
          class="input input--inline"
          value={draft}
          ref={(el) => el?.focus()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span class="checklist__text" onDblClick={() => (setDraft(item.text), setEditing(true))}>
          <Markdown inline text={item.text} />
        </span>
      )}
      <span class="checklist__meta">
        <DuePicker
          value={item.due}
          overdue={Boolean(overdue)}
          onChange={(due) => void changeBody(issue.number, updateItem(ref, { due }))}
        />
        <UserPicker
          compact
          value={item.assignee ?? null}
          triggerClass="btn btn--icon btn--s"
          align="end"
          emptyLabel="Без исполнителя"
          onChange={(login) => void changeBody(issue.number, updateItem(ref, { assignee: login ?? undefined }))}
        />
        <Menu triggerClass="btn btn--icon btn--s" align="end" title="Ещё" label={<Icon name="more" />}>
          {(close) => (
            <>
              <MenuItem onSelect={() => (close(), setDraft(item.text), setEditing(true))}>
                <Icon name="edit" />
                Изменить текст
              </MenuItem>
              <MenuItem danger onSelect={() => (close(), void changeBody(issue.number, removeItem(ref)))}>
                <Icon name="trash" />
                Удалить пункт
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
    </li>
  )
}

function DuePicker({ value, overdue, onChange }: { value: string | undefined; overdue: boolean; onChange: (due: string | undefined) => void }) {
  return (
    <Menu
      triggerClass={value ? `chip${overdue ? ' chip--danger' : ''}` : 'btn btn--icon btn--s'}
      align="end"
      title={value ? `Срок: ${formatDue(value)}` : 'Поставить срок'}
      label={
        value ? (
          <>
            <Icon name="calendar" size={12} />
            {formatDue(value)}
          </>
        ) : (
          <Icon name="calendar" />
        )
      }
    >
      {(close) => (
        <div class="menu__form">
          <input
            type="date"
            class="input"
            value={value ?? ''}
            onChange={(event) => {
              const due = event.currentTarget.value || undefined
              close()
              if (due !== value) onChange(due)
            }}
          />
          {value && (
            <MenuItem onSelect={() => (close(), onChange(undefined))}>
              <Icon name="x" />
              Убрать срок
            </MenuItem>
          )}
        </div>
      )}
    </Menu>
  )
}

function AddChecklistItem({ issue, autoFocus, onDone }: { issue: Issue; autoFocus: boolean; onDone: () => void }) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])
  const add = () => {
    const value = text.trim()
    if (!value) return
    setText('')
    void changeBody(issue.number, addItem({ id: newItemId(), text: value, checked: false }))
  }
  return (
    <div class="add-row">
      <Icon name="plus" class="muted" />
      <input
        ref={input}
        class="input input--ghost"
        placeholder="Добавить пункт"
        value={text}
        onInput={(event) => setText(event.currentTarget.value)}
        onBlur={() => !text && onDone()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') add()
          if (event.key === 'Escape') (setText(''), onDone(), input.current?.blur())
        }}
      />
      {text.trim() && (
        <button type="button" class="btn btn--outlined btn--s" onMouseDown={(event) => event.preventDefault()} onClick={add}>
          Добавить
        </button>
      )}
    </div>
  )
}

// Связи

export function LinksBlock({ issue, adding, onAdded }: { issue: Issue; adding: boolean; onAdded: () => void }) {
  const [picking, setPicking] = useState(false)
  const open = picking || adding
  const close = () => (setPicking(false), onAdded())
  if (!issue.body.links.length && !open) return null
  return (
    <section class="block">
      <div class="block__head">
        <h2 class="block__title">Связи</h2>
        {issue.body.links.length > 0 && <span class="block__counter">{issue.body.links.length}</span>}
        <span class="spacer" />
        {!open && (
          <button type="button" class="btn btn--flat btn--s" onClick={() => setPicking(true)}>
            <Icon name="plus" />
            Связь
          </button>
        )}
      </div>
      {issue.body.links.length > 0 && (
        <>
          <div class="links__group">Связана с</div>
          <ul class="links">
            {issue.body.links.map((number) => (
              <LinkRow key={number} issue={issue} other={number} />
            ))}
          </ul>
        </>
      )}
      {open && <LinkPicker issue={issue} onDone={close} />}
    </section>
  )
}

function LinkRow({ issue, other }: { issue: Issue; other: number }) {
  const linked = issueMap.value.get(other)
  return (
    <li class="link-row">
      <a class="key" href={issueHref(other)}>
        {linked?.key ?? `#${other}`}
      </a>
      {linked ? (
        <>
          <a class="link-row__title" href={issueHref(other)}>
            {linked.title}
          </a>
          <StatusLabel status={linked.status} size="s" />
          {linked.assignee ? <Avatar login={linked.assignee} size="s" /> : <span class="avatar avatar--s avatar--blank" />}
        </>
      ) : (
        <span class="link-row__title muted">задача не найдена</span>
      )}
      <button type="button" class="btn btn--icon btn--s" title="Убрать связь" onClick={() => void linkIssues(issue.number, other, false)}>
        <Icon name="x" />
      </button>
    </li>
  )
}

function LinkPicker({ issue, onDone }: { issue: Issue; onDone: () => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const candidates = issues.value
    .filter((other) => other.number !== issue.number && !issue.body.links.includes(other.number))
    .filter((other) => !q || other.key.toLowerCase().includes(q) || other.title.toLowerCase().includes(q) || `#${other.number}` === q)
    .sort((a, b) => b.number - a.number)
    .slice(0, 8)
  const pick = (number: number) => {
    onDone()
    void linkIssues(issue.number, number, true)
  }
  return (
    <div class="picker">
      <input
        class="input"
        placeholder="Ключ или название задачи"
        value={query}
        ref={(el) => el?.focus()}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && candidates[0]) pick(candidates[0].number)
          if (event.key === 'Escape') onDone()
        }}
      />
      <ul class="picker__list">
        {candidates.map((other) => (
          <li key={other.number}>
            <button type="button" class="picker__item" onClick={() => pick(other.number)}>
              <span class="key">{other.key}</span>
              <span class="picker__title">{other.title}</span>
              <StatusLabel status={other.status} size="s" />
            </button>
          </li>
        ))}
        {!candidates.length && <li class="picker__empty muted">Подходящих задач нет</li>}
      </ul>
      <button type="button" class="btn btn--flat btn--s" onClick={onDone}>
        Отмена
      </button>
    </div>
  )
}

// Вложения

/** blob:-адрес файла из репозитория; null — пока грузится, false — не загрузился. */
function useRepoFile(url: string): string | null | false {
  const current = session.value!
  const [src, setSrc] = useState<string | null | false>(null)
  useEffect(() => {
    const file = repoFileFromUrl(url, current.repo)
    if (!file) {
      setSrc(false)
      return
    }
    let alive = true
    loadRepoFile(current.client, file).then(
      (blobUrl) => alive && setSrc(blobUrl),
      () => alive && setSrc(false),
    )
    return () => {
      alive = false
    }
  }, [url, current.client])
  return src
}

/** Сколько файлов сейчас грузится в каждую задачу: кнопка и блок вложений живут в разных местах. */
const uploadsInFlight = signal<ReadonlyMap<number, number>>(new Map())

function bumpUploads(number: number, delta: number): void {
  const next = new Map(uploadsInFlight.value)
  next.set(number, (next.get(number) ?? 0) + delta)
  uploadsInFlight.value = next
}

async function attachFiles(number: number, files: File[]): Promise<void> {
  for (const file of files) {
    bumpUploads(number, 1)
    try {
      const uploaded = await uploadFile(file, number)
      if (uploaded) await changeBody(number, addAttachment({ name: uploaded.name, url: uploaded.url }))
    } finally {
      bumpUploads(number, -1)
    }
  }
}

/** Кнопка выбора файлов. Это <label> у скрытого поля: так выбор файла открывается везде, включая Safari. */
export function AttachButton({ issue, class: className, children }: { issue: Issue; class: string; children: ComponentChildren }) {
  return (
    <label class={className}>
      {children}
      <input
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const input = event.currentTarget
          const files = [...(input.files ?? [])]
          input.value = ''
          if (files.length) void attachFiles(issue.number, files)
        }}
      />
    </label>
  )
}

export function AttachmentsBlock({ issue }: { issue: Issue }) {
  const files = issue.body.attachments
  const uploading = uploadsInFlight.value.get(issue.number) ?? 0
  if (!files.length && !uploading) return null
  return (
    <section class="block">
      <div class="block__head">
        <h2 class="block__title">Вложения</h2>
        <span class="block__counter">{files.length}</span>
        <span class="spacer" />
        {uploading > 0 && <Spinner />}
        <AttachButton issue={issue} class="btn btn--flat btn--s">
          <Icon name="paperclip" />
          Прикрепить
        </AttachButton>
      </div>
      <div class="attachments">
        {files.map((file) => (
          <AttachmentTile key={file.url} file={file} onRemove={() => void changeBody(issue.number, removeAttachment(file.url))} />
        ))}
      </div>
    </section>
  )
}

function AttachmentTile({ file, onRemove }: { file: Attachment; onRemove: () => void }) {
  const src = useRepoFile(file.url)
  const image = isImageName(file.name)
  return (
    <figure class="tile">
      {image ? (
        <button type="button" class="tile__preview" disabled={!src} onClick={() => src && (lightbox.value = { src, alt: file.name })}>
          {src ? <img src={src} alt={file.name} /> : src === null ? <Spinner /> : <Icon name="image" size={24} />}
        </button>
      ) : (
        <a class="tile__preview" href={src || undefined} download={file.name} aria-disabled={!src}>
          <Icon name="paperclip" size={24} />
        </a>
      )}
      <figcaption class="tile__name" title={file.name}>
        {file.name}
      </figcaption>
      <button
        type="button"
        class="btn btn--icon btn--s tile__remove"
        title="Убрать из задачи"
        onClick={() => confirm(`Убрать «${file.name}» из задачи? Файл останется в репозитории.`) && onRemove()}
      >
        <Icon name="x" />
      </button>
    </figure>
  )
}

// Комментарии

export function CommentsBlock({ issue }: { issue: Issue }) {
  const state = commentsByIssue.value.get(issue.number)
  const viewer = session.value!.viewer
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  useEffect(() => {
    void loadComments(issue.number)
  }, [issue.number])
  // Новые комментарии соседа подтягиваем, когда меняется счётчик задачи.
  const known = state?.status === 'ready' ? state.items.length : null
  useEffect(() => {
    if (known !== null && known !== issue.comments) void loadComments(issue.number)
  }, [issue.comments])

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    const ok = await addComment(issue.number, text)
    setSending(false)
    if (ok) setDraft('')
  }

  return (
    <section class="block block--comments">
      <div class="block__head">
        <h2 class="block__title">Комментарии</h2>
        {issue.comments > 0 && <span class="block__counter">{issue.comments}</span>}
      </div>
      {state?.status === 'loading' && <Spinner />}
      {state?.status === 'error' && (
        <div class="alert alert--error">
          {state.error}{' '}
          <button type="button" class="btn btn--flat btn--s" onClick={() => void loadComments(issue.number)}>
            Повторить
          </button>
        </div>
      )}
      {state?.status === 'ready' && state.items.length > 0 && (
        <ul class="comments">
          {state.items.map((comment) => (
            <CommentItem key={comment.id} issue={issue} comment={comment} own={comment.raw.user?.login === viewer.login} />
          ))}
        </ul>
      )}
      <div class="comment-form">
        <Avatar login={viewer.login} name={viewer.name} />
        <div class="comment-form__body">
          <MarkdownEditor value={draft} onInput={setDraft} issueNumber={issue.number} placeholder="Написать комментарий" minRows={3} onSubmit={send} />
          <div class="form-actions">
            <button type="button" class="btn btn--action" disabled={!draft.trim() || sending} onClick={send}>
              {sending ? 'Отправляю…' : 'Отправить'}
            </button>
            <span class="muted small hide-mobile">⌘/Ctrl + Enter</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function CommentItem({ issue, comment, own }: { issue: Issue; comment: Comment; own: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.text)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!draft.trim() || busy) return
    setBusy(true)
    const ok = await editComment(issue.number, comment, draft)
    setBusy(false)
    if (ok) setEditing(false)
  }
  return (
    <li class="comment">
      <Avatar login={comment.author.login} name={comment.author.name} />
      <div class="comment__body">
        <div class="comment__head">
          <Person login={comment.author.login} name={comment.author.name} />
          <a class="comment__date" href={comment.url} target="_blank" rel="noopener noreferrer">
            <DateText iso={comment.createdAt} />
          </a>
          {comment.migrated && <span class="tag" title="Комментарий перенесён из Яндекс Трекера">из Трекера</span>}
          {comment.edited && <span class="muted small">изменён</span>}
          <span class="spacer" />
          {own && !editing && (
            <Menu triggerClass="btn btn--icon btn--s" align="end" title="Ещё" label={<Icon name="more" />}>
              {(close) => (
                <>
                  <MenuItem onSelect={() => (close(), setDraft(comment.text), setEditing(true))}>
                    <Icon name="edit" />
                    Изменить
                  </MenuItem>
                  <MenuItem
                    danger
                    onSelect={() => {
                      close()
                      if (confirm('Удалить комментарий? Отменить это нельзя.')) void deleteComment(issue.number, comment)
                    }}
                  >
                    <Icon name="trash" />
                    Удалить
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
        {editing ? (
          <>
            <MarkdownEditor value={draft} onInput={setDraft} issueNumber={issue.number} autoFocus onSubmit={save} onCancel={() => setEditing(false)} />
            <div class="form-actions">
              <button type="button" class="btn btn--action" disabled={!draft.trim() || busy} onClick={save}>
                Сохранить
              </button>
              <button type="button" class="btn btn--flat" onClick={() => setEditing(false)}>
                Отмена
              </button>
            </div>
          </>
        ) : (
          <Markdown text={comment.text} />
        )}
      </div>
    </li>
  )
}
