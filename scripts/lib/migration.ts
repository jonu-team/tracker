import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseBody, serializeBody } from '../../src/domain/body.ts'
import { assigneeLogins, labelNames, type GhIssue } from '../../src/domain/github-types.ts'
import { parseCommentBody } from '../../src/domain/issue.ts'
import { MILESTONE_LABEL, statusOf, type StatusKey } from '../../src/domain/status.ts'
import { GitHubError, type GitHubClient } from '../../src/lib/github.ts'
import type { MigrationConfig, TargetIssue, TargetState, TrackerExport } from './target.ts'

/**
 * Перенос целевого состояния (см. target.ts) в репозиторий GitHub и сверка.
 * Перезапуск безопасен: созданное не дублируется, а тела, которые уже
 * правили люди, не перезаписываются.
 */

export interface MigrationContext {
  client: GitHubClient
  config: MigrationConfig
  source: TrackerExport
  target: TargetState
  log: (line: string) => void
  /** Пауза перед каждой записью: у GitHub вторичные лимиты на создание контента. */
  pauseMs: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => new Date().toISOString()

/** Тело без отметки времени переноса — для сравнения «то же самое или нет». */
export function comparable(body: string | null): string {
  const parsed = parseBody(body?.replace(/\r\n/g, '\n') ?? null)
  return serializeBody({ ...parsed, meta: parsed.meta ? { ...parsed.meta, migrated: '' } : null })
}

function withMigrated(body: string, migrated: string): string {
  const parsed = parseBody(body)
  return serializeBody({ ...parsed, meta: { ...parsed.meta, migrated } })
}

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

async function write<T>(ctx: MigrationContext, label: string, action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    await sleep(ctx.pauseMs)
    try {
      return await action()
    } catch (error) {
      if (error instanceof GitHubError && error.rateLimited && attempt < 4) {
        const wait = 60_000 * attempt
        ctx.log(`  ${label}: GitHub ограничил запросы, жду ${wait / 1000} с`)
        await sleep(wait)
        continue
      }
      throw error
    }
  }
}

async function findIssue(client: GitHubClient, number: number): Promise<GhIssue | null> {
  try {
    return await client.issue(number)
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null
    throw error
  }
}

/** Логины исполнителей, которых сейчас можно назначить в репозитории. */
async function assignableLogins(ctx: MigrationContext): Promise<Set<string>> {
  const logins = new Set(ctx.target.issues.flatMap((issue) => issue.assignees))
  const result = new Set<string>()
  for (const login of logins) if (await ctx.client.isAssignable(login)) result.add(login)
  return result
}

/** Проверка репозитория. Возвращает блокирующие проблемы; предупреждения пишет в лог. */
export async function preflight(ctx: MigrationContext): Promise<string[]> {
  const { client, config, target } = ctx
  const problems: string[] = []
  const viewer = await client.viewer()
  ctx.log(`Токен: ${viewer.login}`)
  let repository
  try {
    repository = await client.repository()
  } catch (error) {
    return [`репозиторий ${config.owner}/${config.repo} недоступен: ${(error as Error).message}`]
  }
  if (!repository.private) problems.push('репозиторий публичный — задачи должны лежать в приватном')
  if (!repository.has_issues) problems.push('в репозитории выключены Issues')
  if (repository.default_branch !== config.branch) {
    problems.push(`основная ветка ${repository.default_branch}, а в настройках ${config.branch}`)
  }

  const existing = await client.issues()
  const ours = existing.filter((issue) => parseBody(issue.body).meta?.key === `${config.keyPrefix}-${issue.number}`)
  if (existing.length !== ours.length) {
    problems.push(`в репозитории есть чужие issue (${existing.length - ours.length}) — номера не совпадут`)
  }
  if (ours.length) ctx.log(`Уже перенесено задач: ${ours.length}`)
  if (await client.hasPullRequests()) problems.push('в репозитории есть pull request — они занимают номера задач')

  const assignable = await assignableLogins(ctx)
  for (const login of new Set(target.issues.flatMap((issue) => issue.assignees))) {
    if (assignable.has(login)) continue
    const count = target.issues.filter((issue) => issue.assignees.includes(login)).length
    ctx.log(
      `Внимание: ${login} пока нельзя назначить (нет доступа к репозиторию — приглашение не принято?). ` +
        `${count} задач создадутся без исполнителя; повторный apply назначит их, когда доступ появится.`,
    )
  }
  const authors = new Set(target.issues.flatMap((issue) => issue.comments.map((comment) => comment.author)))
  ctx.log(`Комментарии будут опубликованы от ${viewer.login}; авторы в Трекере: ${[...authors].join(', ') || '—'}`)
  return problems
}

export async function applyMigration(ctx: MigrationContext): Promise<void> {
  const { client, target } = ctx
  const assignable = await assignableLogins(ctx)

  const labels = new Set((await client.labels()).map((label) => label.name))
  for (const label of target.labels) {
    if (labels.has(label.name)) continue
    await write(ctx, `метка ${label.name}`, () => client.createLabel({ ...label }))
    ctx.log(`Метка «${label.name}» создана`)
  }

  for (const file of target.files) {
    const bytes = readFileSync(file.localPath)
    const existing = await client.fileInfo(file.path)
    if (existing?.sha === gitBlobSha(bytes)) continue
    if (existing) throw new Error(`${file.path} уже есть в репозитории, но с другим содержимым`)
    await write(ctx, file.path, () =>
      client.putFile(file.path, bytes.toString('base64'), `Вложение из Трекера: ${file.issueKey}/${file.trackerId}`),
    )
    ctx.log(`Файл ${file.path}`)
  }

  // Задачи создаём по порядку: номер issue = номер в Трекере.
  for (const issue of target.issues) {
    let gh = await findIssue(client, issue.number)
    if (gh) {
      if (parseBody(gh.body).meta?.key !== issue.key) throw new Error(`#${issue.number} уже занят не ${issue.key}`)
    } else {
      const created = await write(ctx, issue.key, () =>
        client.createIssue({
          title: issue.title,
          body: withMigrated(issue.bodyWithoutLinks, now()),
          labels: issue.labels,
          assignees: issue.assignees.filter((login) => assignable.has(login)),
        }),
      )
      if (created.number !== issue.number) {
        throw new Error(`${issue.key} получила номер #${created.number} вместо #${issue.number} — перенос остановлен`)
      }
      gh = created
      ctx.log(`${issue.key} → #${created.number}`)
    }

    const posted = new Set(
      (gh.comments ? await client.comments(issue.number) : []).map((comment) => parseCommentBody(comment.body).origin?.id),
    )
    for (const comment of issue.comments) {
      if (posted.has(comment.originId)) continue
      await write(ctx, `${issue.key} комментарий`, () => client.createComment(issue.number, comment.body))
      ctx.log(`  комментарий ${comment.originId}`)
    }

    if (issue.state === 'closed' && gh.state !== 'closed') {
      await write(ctx, `${issue.key} закрытие`, () =>
        client.updateIssue(issue.number, { state: 'closed', state_reason: 'completed' }),
      )
      ctx.log('  закрыта')
    }
  }

  // Последняя запись в задачу — полное тело со связями и свежей отметкой
  // переноса (все issue уже есть, ссылки #N отрисуются, а дата изменения в
  // интерфейсе останется датой из Трекера) и исполнитель, если он появился
  // в организации после первого запуска.
  for (const issue of target.issues) {
    const gh = (await findIssue(client, issue.number))!
    const current = comparable(gh.body)
    const bodyPending = current !== comparable(issue.body)
    const bodyUntouched = !bodyPending || current === comparable(issue.bodyWithoutLinks)
    const assignees = issue.assignees.filter((login) => assignable.has(login))
    const assigneesPending = assigneeLogins(gh).length === 0 && assignees.length > 0
    if (!bodyPending && !assigneesPending) continue
    if (!bodyUntouched) {
      // тело уже правили люди — его не трогаем, исполнителя ставим отдельно
      if (assigneesPending) {
        await write(ctx, `${issue.key} исполнитель`, () => client.updateIssue(issue.number, { assignees }))
        ctx.log(`${issue.key}: исполнитель ${assignees.join(', ')} (тело изменено после переноса, его не трогаю)`)
      } else {
        ctx.log(`${issue.key}: тело изменили после переноса — не трогаю`)
      }
      continue
    }
    const patch = { body: withMigrated(issue.body, now()), ...(assigneesPending ? { assignees } : {}) }
    await write(ctx, `${issue.key} тело`, () => client.updateIssue(issue.number, patch))
    const changes = [bodyPending && 'связи', assigneesPending && `исполнитель ${assignees.join(', ')}`]
    ctx.log(`${issue.key}: ${changes.filter(Boolean).join(', ')}`)
  }
}

// Сверка

export interface Counts {
  issues: number
  byStatus: Record<StatusKey, number>
  milestones: number
  assigned: Record<string, number>
  comments: number
  checklistItems: number
  checklistChecked: number
  checklistWithAssignee: number
  checklistWithDue: number
  linkRefs: number
  attachments: number
}

function emptyCounts(): Counts {
  return {
    issues: 0,
    byStatus: { open: 0, needInfo: 0, inProgress: 0, closed: 0 },
    milestones: 0,
    assigned: {},
    comments: 0,
    checklistItems: 0,
    checklistChecked: 0,
    checklistWithAssignee: 0,
    checklistWithDue: 0,
    linkRefs: 0,
    attachments: 0,
  }
}

/** Счётчики прямо по выгрузке Трекера — независимо от конвертера. */
export function sourceCounts(source: TrackerExport, config: MigrationConfig): Counts {
  const counts = emptyCounts()
  counts.issues = source.issues.length
  for (const issue of source.issues) {
    counts.byStatus[issue.status.key as StatusKey] += 1
    if (issue.type.key === 'milestone') counts.milestones += 1
    if (issue.assignee?.id) {
      const login = config.users[String(issue.assignee.id)] ?? `?${issue.assignee.display}`
      counts.assigned[login] = (counts.assigned[login] ?? 0) + 1
    }
    counts.comments += issue._comments?.length ?? 0
    for (const item of issue._checklistItems ?? []) {
      counts.checklistItems += 1
      if (item.checked) counts.checklistChecked += 1
      if (item.assignee) counts.checklistWithAssignee += 1
      if (item.deadline?.date) counts.checklistWithDue += 1
    }
    counts.linkRefs += issue._links?.length ?? 0
    counts.attachments += issue._attachments?.length ?? 0
  }
  return counts
}

export interface VerifyResult {
  ok: boolean
  rows: { name: string; expected: string; actual: string; same: boolean }[]
  mismatches: string[]
  extraIssues: number
}

export async function verifyMigration(ctx: MigrationContext): Promise<VerifyResult> {
  const { client, target } = ctx
  const source = sourceCounts(ctx.source, ctx.config)
  const all = await client.issues()
  const issues = all.filter((issue) => issue.number <= target.issues.length)
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]))
  const mismatches: string[] = []
  const actual = emptyCounts()
  actual.issues = issues.length

  for (const expected of target.issues) {
    const gh = byNumber.get(expected.number)
    if (!gh) {
      mismatches.push(`${expected.key}: нет issue #${expected.number}`)
      continue
    }
    const body = parseBody(gh.body)
    const status = statusOf(gh)
    actual.byStatus[status] += 1
    if (labelNames(gh).includes(MILESTONE_LABEL)) actual.milestones += 1
    for (const login of assigneeLogins(gh)) actual.assigned[login] = (actual.assigned[login] ?? 0) + 1
    actual.checklistItems += body.checklist.length
    actual.checklistChecked += body.checklist.filter((item) => item.checked).length
    actual.checklistWithAssignee += body.checklist.filter((item) => item.assignee).length
    actual.checklistWithDue += body.checklist.filter((item) => item.due).length
    actual.linkRefs += body.links.length

    const problems = compareIssue(expected, gh, status)
    const comments = gh.comments ? await client.comments(gh.number) : []
    actual.comments += comments.filter((comment) => parseCommentBody(comment.body).origin).length
    const posted = new Map(comments.map((comment) => [parseCommentBody(comment.body).origin?.id, comment.body]))
    for (const comment of expected.comments) {
      const text = posted.get(comment.originId)
      if (text === undefined) problems.push(`нет комментария ${comment.originId}`)
      else if (text.replace(/\r\n/g, '\n') !== comment.body) problems.push(`комментарий ${comment.originId} отличается`)
    }
    for (const problem of problems) mismatches.push(`${expected.key}: ${problem}`)
  }

  let filesOk = 0
  for (const file of target.files) {
    const info = await client.fileInfo(file.path)
    if (info?.sha === gitBlobSha(readFileSync(file.localPath))) filesOk += 1
    else mismatches.push(`файл ${file.path} ${info ? 'отличается' : 'не найден'}`)
  }
  actual.attachments = filesOk + target.missingFiles.length

  const pairs: [string, number, number, string?][] = [
    ['задач', source.issues, actual.issues],
    ['  открыто', source.byStatus.open, actual.byStatus.open],
    ['  нужна информация', source.byStatus.needInfo, actual.byStatus.needInfo],
    ['  в работе', source.byStatus.inProgress, actual.byStatus.inProgress],
    ['  закрыто', source.byStatus.closed, actual.byStatus.closed],
    ['вех', source.milestones, actual.milestones],
    ...Object.keys({ ...source.assigned, ...actual.assigned }).map(
      (login): [string, number, number] => [`исполнитель ${login}`, source.assigned[login] ?? 0, actual.assigned[login] ?? 0],
    ),
    ['комментариев', source.comments, actual.comments],
    ['пунктов чеклистов', source.checklistItems, actual.checklistItems],
    ['  отмечено', source.checklistChecked, actual.checklistChecked],
    ['  с исполнителем', source.checklistWithAssignee, actual.checklistWithAssignee],
    ['  со сроком', source.checklistWithDue, actual.checklistWithDue],
    ['связей (ссылок)', source.linkRefs, actual.linkRefs],
    ['вложений: файлов + не отданных Трекером', source.attachments, actual.attachments, `${filesOk} + ${target.missingFiles.length}`],
  ]
  const rows = pairs.map(([name, expected, got, shown]) => ({
    name,
    expected: String(expected),
    actual: shown ?? String(got),
    same: expected === got,
  }))
  for (const row of rows) if (!row.same) mismatches.push(`счётчик «${row.name.trim()}»: ${row.expected} ≠ ${row.actual}`)
  return { ok: mismatches.length === 0, rows, mismatches, extraIssues: all.length - issues.length }
}

function compareIssue(expected: TargetIssue, gh: GhIssue, status: StatusKey): string[] {
  const problems: string[] = []
  if (gh.title !== expected.title) problems.push('заголовок')
  if (status !== expected.status) problems.push(`статус ${status} вместо ${expected.status}`)
  if (expected.state === 'closed' && gh.state_reason !== 'completed') problems.push(`причина закрытия ${gh.state_reason}`)
  const labels = labelNames(gh).sort().join(',')
  if (labels !== [...expected.labels].sort().join(',')) problems.push(`метки ${labels || '—'}`)
  if (assigneeLogins(gh).join(',') !== expected.assignees.join(',')) {
    problems.push(`исполнитель ${assigneeLogins(gh).join(',') || '—'} вместо ${expected.assignees.join(',') || '—'}`)
  }
  if (comparable(gh.body) !== comparable(expected.body)) problems.push('тело отличается')
  return problems
}
