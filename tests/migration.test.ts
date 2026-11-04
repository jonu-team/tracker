import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBody } from '../src/domain/body.ts'
import { assigneeLogins } from '../src/domain/github-types.ts'
import { createFakeGitHub, type FakeFixture } from '../src/lib/demo.ts'
import { GitHubClient } from '../src/lib/github.ts'
import { applyMigration, gitBlobSha, preflight, verifyMigration, type MigrationContext } from '../scripts/lib/migration.ts'
import { buildTarget, type MigrationConfig, type TrackerExport } from '../scripts/lib/target.ts'

/** Синтетическая выгрузка: закрытая задача с картинкой и комментарием, две связанные открытые. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-migration-'))
  mkdirSync(join(dir, 'DEV-1'), { recursive: true })
  writeFileSync(join(dir, 'DEV-1', '7-image.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]))

  const source: TrackerExport = {
    exportedAt: '2026-11-04T17:40:59',
    issues: [
      {
        key: 'DEV-1',
        summary: 'Закрытая задача',
        description: 'Экран: ![image.png](/ajax/v2/attachments/7?inline=true =800x600)\nсм. PR #12',
        status: { key: 'closed' },
        type: { key: 'milestone' },
        resolution: { key: 'fixed' },
        assignee: { id: 'u1', display: 'Алиса' },
        createdBy: { display: 'Алиса' },
        createdAt: '2026-08-01T10:00:00.000+0000',
        updatedAt: '2026-08-02T10:00:00.000+0000',
        _comments: [{ id: 1, text: 'Готово', createdBy: { display: 'Алиса' }, createdAt: '2026-08-02T09:00:00.000+0000' }],
        _attachments: [{ id: 7, name: 'image.png' }],
      },
      {
        key: 'DEV-2',
        summary: 'Открытая с чеклистом',
        description: 'Описание',
        status: { key: 'open' },
        type: { key: 'task' },
        createdBy: { display: 'Боб' },
        createdAt: '2026-09-01T10:00:00.000+0000',
        updatedAt: '2026-09-05T10:00:00.000+0000',
        _checklistItems: [
          { id: 'a1', text: 'Первый https://tracker.yandex.ru/DEV-3', checked: true, assignee: { id: 'u2' } },
          { id: 'a2', text: 'Второй', checked: false, deadline: { date: '2026-11-10' } },
        ],
        _links: [{ type: { id: 'relates' }, object: { key: 'DEV-3' } }],
      },
      {
        key: 'DEV-3',
        summary: 'В работе у Боба',
        status: { key: 'inProgress' },
        type: { key: 'task' },
        assignee: { id: 'u2', display: 'Боб' },
        createdBy: { display: 'Алиса' },
        createdAt: '2026-09-02T10:00:00.000+0000',
        updatedAt: '2026-10-01T10:00:00.000+0000',
        _links: [{ type: { id: 'relates' }, object: { key: 'DEV-2' } }],
      },
    ],
  }
  const config: MigrationConfig = {
    owner: 'acme',
    repo: 'tasks',
    branch: 'main',
    keyPrefix: 'DEV',
    users: { u1: 'alice', u2: 'bob' },
    hashRefRepo: 'acme/code',
    exportFile: '',
    attachmentsDir: dir,
  }
  const fixture: FakeFixture = {
    repo: { owner: 'acme', name: 'tasks', default_branch: 'main' },
    viewer: { login: 'alice', id: 1 },
    users: [{ login: 'alice', id: 1 }], // bob ещё не принял приглашение
    labels: [],
    issues: [],
    files: [],
  }
  const fake = createFakeGitHub(fixture, { blobSha: gitBlobSha })
  const log: string[] = []
  const ctx: MigrationContext = {
    client: new GitHubClient({ token: 'test', repo: fake.repo, fetch: fake.fetch }),
    config,
    source,
    target: buildTarget(source, config, new Date().toISOString()),
    log: (line) => log.push(line),
    pauseMs: 0,
  }
  return { ctx, fake, fixture, log }
}

describe('перенос в GitHub', () => {
  it('сохраняет номера, статусы, комментарии, файлы и связи', async () => {
    const { ctx, fake, log } = setup()
    expect(await preflight(ctx)).toEqual([])
    expect(log.some((line) => line.includes('bob пока нельзя назначить'))).toBe(true)

    await applyMigration(ctx)
    const [first, second, third] = [1, 2, 3].map((n) => fake.state.issues.get(n)!)
    expect([first!.title, second!.title, third!.title]).toEqual(['Закрытая задача', 'Открытая с чеклистом', 'В работе у Боба'])
    expect(first).toMatchObject({ state: 'closed', state_reason: 'completed' })
    expect(first!.labels).toEqual([{ name: 'Веха' }])
    expect(third!.labels).toEqual([{ name: 'В работе' }])
    expect(fake.state.comments.get(1)).toHaveLength(1)
    expect([...fake.state.uploads.keys()]).toEqual(['attachments/DEV-1/7-image.png'])

    const body1 = parseBody(first!.body)
    expect(body1.description).toContain('![image.png](https://github.com/acme/tasks/blob/main/attachments/DEV-1/7-image.png?raw=true)')
    expect(body1.description).toContain('[#12](https://github.com/acme/code/pull/12)')
    const body2 = parseBody(second!.body)
    expect(body2.links).toEqual([3])
    expect(body2.checklist).toMatchObject([
      { text: 'Первый #3', checked: true, assignee: 'bob' },
      { text: 'Второй', checked: false, due: '2026-11-10' },
    ])
    expect(parseBody(third!.body).links).toEqual([2])

    // Последняя запись ставит отметку переноса: интерфейс покажет даты из Трекера.
    const migrated = Date.parse(parseBody(second!.body).meta!.migrated!)
    expect(Math.abs(Date.parse(second!.updated_at) - migrated)).toBeLessThan(5000)

    const before = await verifyMigration(ctx)
    expect(before.ok).toBe(false)
    expect(before.mismatches).toContain('DEV-3: исполнитель — вместо bob')
  })

  it('повторный запуск ничего не дублирует, назначает появившегося исполнителя и не трогает правки людей', async () => {
    const { ctx, fake, fixture, log } = setup()
    await applyMigration(ctx)

    // Боб принял приглашение, а Алиса успела поправить описание DEV-2.
    fixture.users.push({ login: 'bob', id: 2 })
    const edited = fake.state.issues.get(2)!
    fake.state.issues.set(2, { ...edited, body: `Новое описание\n\n${edited.body}` })

    log.length = 0
    await applyMigration(ctx)
    expect(fake.state.issues.size).toBe(3)
    expect(fake.state.comments.get(1)).toHaveLength(1)
    expect(assigneeLogins(fake.state.issues.get(3)!)).toEqual(['bob'])
    expect(parseBody(fake.state.issues.get(2)!.body).description).toContain('Новое описание')
    expect(log).toEqual(['DEV-2: тело изменили после переноса — не трогаю', 'DEV-3: исполнитель bob'])

    const after = await verifyMigration(ctx)
    expect(after.mismatches).toEqual(['DEV-2: тело отличается'])
    expect(after.rows.find((row) => row.name === 'комментариев')).toMatchObject({ expected: '1', actual: '1', same: true })
  })

  it('не начинает перенос в репозиторий, где номера уже заняты', async () => {
    const { ctx, fixture } = setup()
    fixture.issues.push({
      number: 1,
      title: 'Чужая задача',
      body: 'без маркеров',
      state: 'open',
      labels: [],
      user: null,
      comments: 0,
      created_at: '',
      updated_at: '',
      closed_at: null,
      html_url: '',
      _comments: [],
    })
    const fresh = createFakeGitHub(fixture, { blobSha: gitBlobSha })
    const problems = await preflight({ ...ctx, client: new GitHubClient({ token: 'test', repo: fresh.repo, fetch: fresh.fetch }) })
    expect(problems).toEqual(['в репозитории есть чужие issue (1) — номера не совпадут'])
  })
})
