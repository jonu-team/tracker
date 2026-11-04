import { describe, expect, it } from 'vitest'
import { emptyBody, parseBody, serializeBody, withItemIds, type IssueBody } from '../src/domain/body.ts'
import { parseCommentBody, migratedCommentBody, toIssue } from '../src/domain/issue.ts'
import type { GhIssue } from '../src/domain/github-types.ts'
import { statusOf, statusPatch } from '../src/domain/status.ts'

const full: IssueBody = {
  ...emptyBody(),
  description: '## Что сделать\n\nТекст с `кодом` и [ссылкой](https://example.com).\n\n- [ ] пункт описания',
  checklist: [
    { id: 'a1b2c3d4', text: 'Первый пункт', checked: true, assignee: 'alice' },
    { id: 'b2c3d4e5', text: 'Второй -- с тире > и скобкой', checked: false, due: '2026-11-10' },
  ],
  links: [31, 4],
  attachments: [{ name: 'screen [1].png', url: 'https://github.com/o/r/blob/main/attachments/DEV-1/1-screen.png?raw=true' }],
  meta: { key: 'DEV-1', author: 'Автор', created: '2026-03-15T10:00:00.000Z', migrated: '2026-11-05T00:00:00.000Z' },
}

describe('тело задачи', () => {
  it('переживает запись и разбор без потерь', () => {
    const parsed = parseBody(serializeBody(full))
    expect(parsed).toEqual({ ...full, links: [4, 31] })
  })

  it('пишет секции, которые читаются в GitHub', () => {
    const text = serializeBody(full)
    expect(text).toContain('<!-- tt:checklist -->\n### Чеклист\n\n- [x] Первый пункт <!-- {"id":"a1b2c3d4","assignee":"alice"} -->')
    expect(text).toContain('**Связана с:** #4, #31')
    expect(text).toContain('![screen \\[1\\].png](https://github.com/o/r/blob/main/attachments/DEV-1/1-screen.png?raw=true)')
    // `--` и `>` внутри маркера не должны закрыть HTML-комментарий раньше времени
    const markers = text.match(/<!--[\s\S]*?-->/g) ?? []
    for (const marker of markers) expect(marker.slice(4, -3)).not.toMatch(/--|>/)
  })

  it('пустое тело и тело без секций — это описание', () => {
    expect(parseBody(null)).toEqual(emptyBody())
    expect(parseBody('Просто текст\r\nвторая строка').description).toBe('Просто текст\nвторая строка')
    expect(serializeBody({ ...emptyBody(), description: 'x' })).toBe('x')
  })

  it('принимает пункты, добавленные вручную в GitHub, и выдаёт им id', () => {
    const parsed = parseBody('<!-- tt:checklist -->\n### Чеклист\n\n- [x] старый <!-- {"id":"11111111"} -->\n* [ ] новый')
    expect(parsed.checklist.map((item) => [item.id, item.text, item.checked])).toEqual([
      ['11111111', 'старый', true],
      ['', 'новый', false],
    ])
    const withIds = withItemIds(parsed)
    expect(withIds.checklist[1]!.id).toMatch(/^[0-9a-f]{8}$/)
    expect(withIds.checklist[0]!.id).toBe('11111111')
  })

  it('не теряет текст, дописанный в GitHub после служебных секций', () => {
    const parsed = parseBody(
      'Описание\n\n<!-- tt:links -->\n**Связана с:** #2\nдописал руками\n\n<!-- tt:meta {"key":"DEV-1"} -->\nещё строка',
    )
    expect(parsed.links).toEqual([2])
    expect(parsed.meta).toEqual({ key: 'DEV-1' })
    expect(parsed.description).toBe('Описание\n\nдописал руками\nещё строка')
  })

  it('сохраняет незнакомые секции дословно', () => {
    const text = 'Описание\n\n<!-- tt:future {"v":2} -->\nчто-то новое'
    expect(serializeBody(parseBody(text))).toBe(text)
  })

  it('битый JSON в маркере не ломает разбор', () => {
    const parsed = parseBody('<!-- tt:checklist -->\n- [ ] пункт <!-- {oops} -->')
    expect(parsed.checklist).toEqual([{ id: '', text: 'пункт', checked: false }])
  })
})

describe('статусы', () => {
  const issue = (state: 'open' | 'closed', labels: string[]) => ({ state, labels: labels.map((name) => ({ name })) })

  it('выводит статус из состояния и меток', () => {
    expect(statusOf(issue('open', []))).toBe('open')
    expect(statusOf(issue('open', ['Нужна информация']))).toBe('needInfo')
    expect(statusOf(issue('open', ['В работе', 'Веха']))).toBe('inProgress')
    expect(statusOf(issue('closed', ['В работе']))).toBe('closed')
  })

  it('меняет только метки статуса, остальные сохраняет', () => {
    expect(statusPatch(issue('open', ['Открыт', 'Веха']), 'inProgress')).toEqual({ labels: ['Веха', 'В работе'] })
    expect(statusPatch(issue('open', ['В работе']), 'closed')).toEqual({
      state: 'closed',
      state_reason: 'completed',
      labels: [],
    })
    expect(statusPatch(issue('closed', ['Веха']), 'open')).toEqual({ state: 'open', labels: ['Веха', 'Открыт'] })
  })
})

describe('перенесённые задачи и комментарии', () => {
  const gh = (updated: string): GhIssue => ({
    number: 1,
    title: 't',
    body: serializeBody(full),
    state: 'open',
    labels: [],
    assignees: [],
    user: { login: 'migrator', id: 1 },
    comments: 0,
    created_at: '2026-11-05T00:00:00Z',
    updated_at: updated,
    closed_at: null,
    html_url: '',
  })

  it('показывает даты из Трекера, пока задачу не меняли после переноса', () => {
    const fresh = toIssue(gh('2026-11-05T00:00:03Z'), 'DEV')
    expect(fresh.key).toBe('DEV-1')
    expect(fresh.createdAt).toBe('2026-03-15T10:00:00.000Z')
    expect(fresh.updatedAt).toBe('2026-11-05T00:00:03Z') // в meta нет updated — берём из GitHub
    expect(fresh.author).toEqual({ login: null, name: 'Автор' })

    const body = serializeBody({ ...full, meta: { ...full.meta, updated: '2026-10-01T00:00:00.000Z' } })
    expect(toIssue({ ...gh('2026-11-05T00:00:03Z'), body }, 'DEV').updatedAt).toBe('2026-10-01T00:00:00.000Z')
    // правка через 10 минут после переноса — уже настоящее изменение
    expect(toIssue({ ...gh('2026-11-05T00:10:00Z'), body }, 'DEV').updatedAt).toBe('2026-11-05T00:10:00Z')
  })

  it('разбирает подпись перенесённого комментария', () => {
    const origin = { id: '7', author: 'Автор', created: '2026-09-13T20:46:00.000Z' }
    const body = migratedCommentBody('Текст\n', origin, 'Перенесено из Яндекс Трекера · Автор')
    expect(body).toBe(
      'Текст\n\n<sub>Перенесено из Яндекс Трекера · Автор</sub>\n<!-- tt:origin {"id":"7","author":"Автор","created":"2026-09-13T20:46:00.000Z"} -->',
    )
    const parsed = parseCommentBody(body)
    expect(parsed.text).toBe('Текст')
    expect(parsed.origin).toEqual(origin)
    // при правке комментария подпись возвращается на место дословно
    expect(parsed.text + parsed.tail).toBe(body)
    expect(parseCommentBody('обычный комментарий')).toEqual({ text: 'обычный комментарий', origin: null, tail: '' })
  })
})
