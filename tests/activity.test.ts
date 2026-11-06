import { describe, expect, it } from 'vitest'
import { bodyChanges, buildHistory, withoutComments, type Change } from '../src/domain/activity.ts'
import { emptyBody, serializeBody, type IssueBody } from '../src/domain/body.ts'
import { diffLines, withContext } from '../src/domain/diff.ts'
import type { GqlContentEdit, GqlIssueActivity, GqlTimelineItem } from '../src/domain/github-types.ts'
import { migratedCommentBody } from '../src/domain/issue.ts'
import { createFakeGitHub, type FakeFixture } from '../src/lib/demo.ts'
import { GitHubClient } from '../src/lib/github.ts'

const body = (patch: Partial<IssueBody>): IssueBody => ({ ...emptyBody(), ...patch })
const item = (id: string, text: string, extra: Partial<IssueBody['checklist'][number]> = {}) => ({ id, text, checked: false, ...extra })

/** Время от начала дня: `t(10, 5)` — 10:05:00 UTC. */
const t = (hours: number, minutes = 0, seconds = 0) =>
  new Date(Date.UTC(2026, 10, 6, hours, minutes, seconds)).toISOString().replace('.000Z', 'Z')

let seq = 0
const id = () => `node-${++seq}`
const by = (login: string) => ({ login })

function labeled(at: string, actor: string, name: string, added = true): GqlTimelineItem {
  return { __typename: added ? 'LabeledEvent' : 'UnlabeledEvent', id: id(), createdAt: at, actor: by(actor), label: { name } }
}
function assigned(at: string, actor: string, login: string, added = true): GqlTimelineItem {
  return { __typename: added ? 'AssignedEvent' : 'UnassignedEvent', id: id(), createdAt: at, actor: by(actor), assignee: { login } }
}
function closed(at: string, actor: string, close = true): GqlTimelineItem {
  return { __typename: close ? 'ClosedEvent' : 'ReopenedEvent', id: id(), createdAt: at, actor: by(actor) }
}
function renamed(at: string, actor: string, previousTitle: string, currentTitle: string): GqlTimelineItem {
  return { __typename: 'RenamedTitleEvent', id: id(), createdAt: at, actor: by(actor), previousTitle, currentTitle }
}
function comment(at: string, author: string, text: string): GqlTimelineItem {
  const databaseId = ++seq
  return { __typename: 'IssueComment', id: id(), databaseId, createdAt: at, author: by(author), body: text, url: `https://github.com/o/r/issues/1#issuecomment-${databaseId}` }
}
function version(at: string, editor: string, content: IssueBody): GqlContentEdit {
  return { id: id(), editedAt: at, deletedAt: null, editor: by(editor), diff: serializeBody(content) }
}

function activity(input: {
  author: string
  createdAt: string
  state?: 'OPEN' | 'CLOSED'
  labels?: string[]
  assignees?: string[]
  body?: IssueBody
  timeline?: GqlTimelineItem[]
  /** От старой версии к новой, как удобно писать; GitHub отдаёт наоборот. */
  versions?: GqlContentEdit[]
  totals?: { timeline?: number; edits?: number }
}): GqlIssueActivity {
  const versions = input.versions ?? []
  const timeline = input.timeline ?? []
  const lastBody = versions.at(-1)?.diff ?? serializeBody(input.body ?? emptyBody())
  return {
    number: 1,
    title: 'Задача',
    body: lastBody,
    state: input.state ?? 'OPEN',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    author: by(input.author),
    labels: { nodes: (input.labels ?? []).map((name) => ({ name })) },
    assignees: { nodes: (input.assignees ?? []).map(by) },
    userContentEdits: { totalCount: input.totals?.edits ?? versions.length, nodes: [...versions].reverse() },
    timelineItems: { totalCount: input.totals?.timeline ?? timeline.length, nodes: timeline },
  }
}

const kinds = (changes: Change[]) => changes.map((change) => change.kind)

describe('правки тела задачи', () => {
  const before = body({
    description: 'Первая строка\nВторая',
    checklist: [item('a', 'Макет'), item('b', 'Вёрстка', { due: '2026-11-10' }), item('c', 'Тесты')],
    links: [3],
    attachments: [{ name: 'old.png', url: 'u1' }],
  })

  it('видны по отдельности: описание, пункты, связи, файлы', () => {
    const after = body({
      description: 'Первая строка\nВторая, исправленная',
      checklist: [item('a', 'Макет', { checked: true }), item('b', 'Вёрстка страницы', { due: '2026-11-12', assignee: 'bob' }), item('d', 'Деплой')],
      links: [3, 5],
      attachments: [{ name: 'new.png', url: 'u2' }],
    })
    expect(bodyChanges(before, after)).toEqual([
      { kind: 'description', from: 'Первая строка\nВторая', to: 'Первая строка\nВторая, исправленная' },
      { kind: 'itemChecked', text: 'Макет', checked: true },
      { kind: 'itemText', from: 'Вёрстка', to: 'Вёрстка страницы' },
      { kind: 'itemAssignee', text: 'Вёрстка страницы', from: null, to: 'bob' },
      { kind: 'itemDue', text: 'Вёрстка страницы', from: '2026-11-10', to: '2026-11-12' },
      { kind: 'itemAdded', text: 'Деплой' },
      { kind: 'itemRemoved', text: 'Тесты' },
      { kind: 'link', number: 5, added: true },
      { kind: 'attachment', name: 'new.png', added: true },
      { kind: 'attachment', name: 'old.png', added: false },
    ])
  })

  it('id, выданные пунктам из GitHub, и служебные отметки — не изменения', () => {
    const fromGitHub = body({ checklist: [item('', 'Макет'), item('', 'Тесты')], meta: { migrated: t(9) } })
    const withIds = body({ checklist: [item('x1', 'Макет'), item('x2', 'Тесты')], meta: { migrated: t(10) } })
    expect(bodyChanges(fromGitHub, withIds)).toEqual([])
  })

  it('перестановка пунктов — одна строка', () => {
    const reordered = body({ ...before, checklist: [before.checklist[2]!, before.checklist[0]!, before.checklist[1]!] })
    expect(bodyChanges(before, reordered)).toEqual([{ kind: 'itemsReordered' }])
  })
})

describe('история задачи', () => {
  it('собирает статус из снятой и поставленной метки, захода — в одну запись', () => {
    const v0 = body({ checklist: [item('a', 'Макет')] })
    const v1 = body({ checklist: [item('a', 'Макет', { checked: true })] })
    const history = buildHistory(
      activity({
        author: 'alice',
        createdAt: t(9),
        state: 'CLOSED',
        labels: ['Веха'],
        assignees: ['bob'],
        timeline: [
          labeled(t(9, 0, 1), 'alice', 'Открыт'),
          assigned(t(9, 0, 1), 'alice', 'bob'),
          labeled(t(10), 'bob', 'Открыт', false),
          labeled(t(10), 'bob', 'В работе'),
          comment(t(10, 2), 'bob', '> цитата\n\nСделал **макет**'),
          renamed(t(12), 'alice', 'Задача', 'Задача про макет'),
          labeled(t(12, 1), 'alice', 'Веха'),
          closed(t(15), 'alice'),
          labeled(t(15), 'alice', 'В работе', false),
        ],
        versions: [version(t(9), 'alice', v0), version(t(10, 1), 'bob', v1)],
      }),
    )
    expect(history.entries.map((entry) => [entry.actor.login, entry.at, entry.changes])).toEqual([
      ['alice', t(15), [{ kind: 'status', from: 'inProgress', to: 'closed' }]],
      [
        'alice',
        t(12, 1),
        [
          { kind: 'title', from: 'Задача', to: 'Задача про макет' },
          { kind: 'milestone', from: false, to: true },
        ],
      ],
      [
        'bob',
        t(10, 2),
        [
          { kind: 'status', from: 'open', to: 'inProgress' },
          { kind: 'itemChecked', text: 'Макет', checked: true },
          { kind: 'comment', id: expect.any(Number), text: '> цитата\n\nСделал **макет**', url: expect.any(String) },
        ],
      ],
      // Метки и исполнитель при создании — начальные значения, а не правка.
      ['alice', t(9), [{ kind: 'created' }, { kind: 'assignee', to: 'bob' }]],
    ])
    expect(history.truncated).toBe(false)
    expect(withoutComments(history.entries)[2]!.changes.map((change) => change.kind)).toEqual(['status', 'itemChecked'])
  })

  it('правка, отменённая в том же заходе, в историю не попадает', () => {
    const v0 = body({ checklist: [item('a', 'Макет')] })
    const v1 = body({ checklist: [item('a', 'Макет', { checked: true })] })
    const history = buildHistory(
      activity({
        author: 'alice',
        createdAt: t(9),
        timeline: [assigned(t(11), 'bob', 'bob'), assigned(t(11, 0, 3), 'bob', 'bob', false)],
        versions: [version(t(9), 'alice', v0), version(t(11, 1), 'bob', v1), version(t(11, 1, 2), 'bob', v0)],
      }),
    )
    expect(history.entries.map((entry) => kinds(entry.changes))).toEqual([['created']])
  })

  it('перенос из Трекера: свои действия переноса скрыты, чужие правки рядом — нет', () => {
    const meta = { key: 'DEV-1', author: 'Алиса Трекер', created: '2026-03-15T11:00:00.000Z' }
    const migratedAt = (at: string, content: IssueBody) => body({ ...content, meta: { ...meta, migrated: at } })
    const original = body({ checklist: [item('a', 'Макет')] })
    const withLinks = { ...original, links: [2] }
    const checked = { ...withLinks, checklist: [item('a', 'Макет', { checked: true })] }
    const history = buildHistory(
      activity({
        author: 'rafael',
        createdAt: t(9),
        state: 'CLOSED',
        labels: ['Веха', 'Срочно'],
        assignees: ['bob'],
        timeline: [
          labeled(t(9, 0, 1), 'rafael', 'Веха'),
          comment(t(9, 0, 2), 'rafael', migratedCommentBody('Из Трекера', { id: '1', author: 'Алиса', created: t(8) }, 'Алиса')),
          closed(t(9, 0, 3), 'rafael'),
          // второй запуск переноса через сутки: тело и исполнитель одним запросом
          assigned('2026-11-07T11:00:00Z', 'rafael', 'bob'),
          // bob правит сразу после переноса — это не перенос
          labeled('2026-11-07T11:01:00Z', 'bob', 'Срочно'),
        ],
        versions: [
          version(t(9), 'rafael', migratedAt(t(9), original)),
          version(t(9, 3), 'rafael', migratedAt(t(9, 3), withLinks)),
          version('2026-11-07T11:00:00Z', 'rafael', migratedAt('2026-11-07T10:59:59Z', withLinks)),
          version('2026-11-07T12:00:00Z', 'rafael', migratedAt('2026-11-07T10:59:59Z', checked)),
        ],
      }),
    )
    expect(history.entries.map((entry) => [entry.actor.login ?? entry.actor.name, entry.historyOnly, entry.changes])).toEqual([
      ['rafael', false, [{ kind: 'itemChecked', text: 'Макет', checked: true }]],
      ['bob', false, [{ kind: 'label', name: 'Срочно', added: true }]],
      ['rafael', true, [{ kind: 'migrated' }]],
      ['Алиса Трекер', true, [{ kind: 'createdInTracker' }]],
    ])
  })

  it('честно говорит, что история неполная, и не выдумывает начальное состояние', () => {
    const history = buildHistory(
      activity({
        author: 'alice',
        createdAt: t(9),
        labels: ['В работе'],
        timeline: [labeled(t(10), 'bob', 'В работе')],
        totals: { timeline: 150 },
      }),
    )
    expect(history.truncated).toBe(true)
    expect(history.entries.map((entry) => entry.changes)).toEqual([
      [{ kind: 'status', from: 'open', to: 'inProgress' }],
      [{ kind: 'created' }],
    ])
  })
})

describe('история через поддельный GitHub', () => {
  const fixture: FakeFixture = {
    repo: { owner: 'o', name: 'r', default_branch: 'main' },
    viewer: { login: 'alice', id: 1, name: 'Алиса' },
    users: [
      { login: 'alice', id: 1, name: 'Алиса' },
      { login: 'bob', id: 2, name: 'Боб' },
    ],
    labels: [],
    issues: [],
    files: [],
  }

  it('правки записываются от того, кто их сделал, и находятся по времени', async () => {
    const fake = createFakeGitHub(fixture)
    const client = new GitHubClient({ token: 'test', repo: fake.repo, fetch: fake.fetch })
    const created = await client.createIssue({ title: 'Макет', body: serializeBody(body({ checklist: [item('a', 'Эскиз')] })), labels: ['Открыт'] })
    const start = new Date().toISOString()

    fake.actAs('bob')
    await client.updateIssue(created.number, { labels: ['В работе'], assignees: ['alice'] })
    await client.updateIssue(created.number, { body: serializeBody(body({ checklist: [item('a', 'Эскиз', { checked: true })] })) })
    await client.createComment(created.number, 'Готово')
    fake.actAs(null)

    const history = buildHistory((await client.issueActivity(created.number))!)
    expect(history.entries.map((entry) => [entry.actor.login, kinds(entry.changes)])).toEqual([
      ['bob', ['status', 'assignee', 'itemChecked', 'comment']],
      ['alice', ['created']],
    ])
    expect(history.entries[0]!.changes[1]).toEqual({ kind: 'assignee', from: null, to: 'alice' })

    const recent = await client.recentActivity(start)
    expect(recent.map((issue) => issue.number)).toEqual([created.number])
    expect(await client.recentActivity(new Date(Date.now() + 60_000).toISOString())).toEqual([])
    await expect(client.issueActivity(999)).rejects.toMatchObject({ status: 404 })
  })
})

describe('построчная разница', () => {
  it('находит добавленные и удалённые строки', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'B' },
      { type: 'same', text: 'c' },
      { type: 'added', text: 'd' },
    ])
    expect(diffLines('', 'новое')).toEqual([{ type: 'added', text: 'новое' }])
  })

  it('сворачивает неизменённое вдали от правок', () => {
    const before = Array.from({ length: 10 }, (_, i) => `строка ${i}`).join('\n')
    const after = before.replace('строка 8', 'строка восемь')
    expect(withContext(diffLines(before, after), 1).map((row) => (row.type === 'skip' ? `…${row.count}` : row.type))).toEqual([
      '…7',
      'same',
      'removed',
      'added',
      'same',
    ])
  })
})
