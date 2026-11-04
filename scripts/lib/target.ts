import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyBody,
  serializeBody,
  type ChecklistItem,
  type IssueBody,
} from '../../src/domain/body.ts'
import { migratedCommentBody } from '../../src/domain/issue.ts'
import { MILESTONE_LABEL, STATUSES, TRACKER_LABELS, type StatusKey } from '../../src/domain/status.ts'
import { encodePath } from '../../src/lib/github.ts'
import { yfmToGfm, type YfmContext } from './yfm.ts'

/**
 * Целевое состояние репозитория с задачами, собранное из выгрузки Трекера.
 * Его же применяет перенос, с ним же сверяется проверка, его же показывает
 * демо-режим сайта.
 */

export interface MigrationConfig {
  owner: string
  repo: string
  branch: string
  keyPrefix: string
  /** id пользователя Трекера → логин GitHub. */
  users: Record<string, string>
  /** Репозиторий, на PR которого ссылаются голые `#123` в текстах задач. */
  hashRefRepo?: string
  exportFile: string
  attachmentsDir: string
}

export interface TargetFile {
  path: string
  localPath: string
  issueKey: string
  trackerId: string
  thumbnailOnly: boolean
}

export interface TargetComment {
  originId: string
  author: string
  created: string
  body: string
}

export interface TargetIssue {
  number: number
  key: string
  title: string
  /** Полное тело, как после переноса. */
  body: string
  /** Тело без связей: с ним issue создаётся, связи дописываются, когда все issue уже есть. */
  bodyWithoutLinks: string
  labels: string[]
  assignees: string[]
  state: 'open' | 'closed'
  status: StatusKey
  comments: TargetComment[]
  parsed: IssueBody
}

export interface MissingFile {
  issueKey: string
  trackerId: string
  name: string
}

export interface TargetState {
  config: MigrationConfig
  migratedAt: string
  labels: typeof TRACKER_LABELS
  issues: TargetIssue[]
  files: TargetFile[]
  missingFiles: MissingFile[]
  warnings: string[]
}

// Типы выгрузки Трекера: только используемые поля.

interface TrackerRef {
  id?: string | number
  key?: string
  display?: string
}

interface TrackerIssue {
  key: string
  summary: string
  description?: string | null
  status: { key: string }
  type: { key: string }
  resolution?: { key: string } | null
  assignee?: TrackerRef | null
  createdBy: TrackerRef
  createdAt: string
  updatedAt: string
  _comments?: { id: number | string; text?: string | null; createdBy: TrackerRef; createdAt: string }[]
  _checklistItems?: {
    id: string
    text: string
    checked: boolean
    assignee?: TrackerRef | null
    deadline?: { date?: string } | null
  }[]
  _links?: { type: { id: string }; object: { key: string } }[]
  _attachments?: { id: number | string; name: string }[]
}

export interface TrackerExport {
  exportedAt: string
  issues: TrackerIssue[]
}

const STATUS_MAP: Record<string, StatusKey> = {
  open: 'open',
  needInfo: 'needInfo',
  inProgress: 'inProgress',
  closed: 'closed',
}

const MSK = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function buildTarget(data: TrackerExport, config: MigrationConfig, migratedAt: string): TargetState {
  const warnings: string[] = []
  const prefix = `${config.keyPrefix}-`
  const issues = [...data.issues].sort((a, b) => keyNumber(a.key) - keyNumber(b.key))

  issues.forEach((issue, index) => {
    if (keyNumber(issue.key) !== index + 1) {
      throw new Error(`Ключи идут с пропуском: на месте ${prefix}${index + 1} стоит ${issue.key}`)
    }
  })

  // Файлы вложений: по id, потому что задача может встраивать картинку из соседней.
  const files = new Map<string, TargetFile>()
  const missingFiles: MissingFile[] = []
  for (const issue of issues) {
    for (const attachment of issue._attachments ?? []) {
      const id = String(attachment.id)
      const regular = `${id}-${attachment.name}`
      const thumbnail = `${id}-thumbnail-only.png`
      const local = [regular, thumbnail].find((name) => existsSync(join(config.attachmentsDir, issue.key, name)))
      if (!local) {
        missingFiles.push({ issueKey: issue.key, trackerId: id, name: attachment.name })
        continue
      }
      files.set(id, {
        path: `attachments/${issue.key}/${local}`,
        localPath: join(config.attachmentsDir, issue.key, local),
        issueKey: issue.key,
        trackerId: id,
        thumbnailOnly: local === thumbnail,
      })
    }
  }

  const fileUrl = (file: TargetFile) =>
    `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${encodePath(file.path)}?raw=true`

  const ctx: YfmContext = {
    attachment(id) {
      const file = files.get(id)
      if (!file) return null
      return file.thumbnailOnly
        ? { url: fileUrl(file), note: 'только миниатюра: оригинал Трекер не отдаёт' }
        : { url: fileUrl(file) }
    },
    missing: (id, name) => `_[Картинка «${name}» не перенесена: Трекер не отдаёт файл вложения ${id}]_`,
    queue: config.keyPrefix,
    issueUrl: (number) => `https://github.com/${config.owner}/${config.repo}/issues/${number}`,
    ...(config.hashRefRepo ? { hashRefRepo: config.hashRefRepo } : {}),
  }

  const user = (ref: TrackerRef | null | undefined, where: string): string | undefined => {
    if (!ref?.id) return undefined
    const login = config.users[String(ref.id)]
    if (!login) warnings.push(`${where}: нет логина GitHub для «${ref.display ?? ref.id}»`)
    return login
  }

  const target: TargetIssue[] = issues.map((issue) => {
    const number = keyNumber(issue.key)
    const status = STATUS_MAP[issue.status.key]
    if (!status) throw new Error(`${issue.key}: неизвестный статус ${issue.status.key}`)
    if (status === 'closed' && issue.resolution && issue.resolution.key !== 'fixed') {
      warnings.push(`${issue.key}: резолюция ${issue.resolution.key} перенесётся как «выполнено»`)
    }

    const description = yfmToGfm(issue.description ?? '', ctx)
    for (const warning of description.warnings) warnings.push(`${issue.key}: ${warning}`)
    const inline = new Set(description.attachments)

    const comments = [...(issue._comments ?? [])]
      .sort((a, b) => Date.parse(isoDate(a.createdAt)) - Date.parse(isoDate(b.createdAt)))
      .map((comment): TargetComment => {
        const converted = yfmToGfm(comment.text ?? '', ctx)
        for (const id of converted.attachments) inline.add(id)
        for (const warning of converted.warnings) warnings.push(`${issue.key}, комментарий ${comment.id}: ${warning}`)
        const author = comment.createdBy.display ?? 'неизвестный автор'
        const created = isoDate(comment.createdAt)
        return {
          originId: String(comment.id),
          author,
          created,
          body: migratedCommentBody(
            converted.markdown,
            { id: String(comment.id), author, created },
            `Перенесено из Яндекс Трекера · ${author} · ${MSK.format(new Date(created))} МСК`,
          ),
        }
      })

    const checklist: ChecklistItem[] = (issue._checklistItems ?? []).map((item) => {
      const converted: ChecklistItem = {
        id: shortHash(item.id),
        text: yfmToGfm(item.text, ctx).markdown.replace(/\s*\n\s*/g, ' '),
        checked: item.checked,
      }
      const login = user(item.assignee, `${issue.key}, пункт чеклиста`)
      if (login) converted.assignee = login
      const due = item.deadline?.date?.slice(0, 10)
      if (due) converted.due = due
      return converted
    })

    const links: number[] = []
    for (const link of issue._links ?? []) {
      if (link.type.id !== 'relates') warnings.push(`${issue.key}: связь типа ${link.type.id} перенесётся как «связана с»`)
      if (!link.object.key.startsWith(prefix)) {
        warnings.push(`${issue.key}: связь с ${link.object.key} из другой очереди не переносится`)
        continue
      }
      const other = keyNumber(link.object.key)
      if (!links.includes(other)) links.push(other)
    }

    const attachments = (issue._attachments ?? [])
      .map((attachment) => String(attachment.id))
      .filter((id) => !inline.has(id) && files.has(id))
      .map((id) => ({ name: files.get(id)!.path.split('/').pop()!, url: fileUrl(files.get(id)!) }))

    const parsed: IssueBody = {
      ...emptyBody(),
      description: description.markdown,
      checklist,
      links: links.sort((a, b) => a - b),
      attachments,
      meta: {
        key: issue.key,
        author: issue.createdBy.display ?? '',
        created: isoDate(issue.createdAt),
        updated: isoDate(issue.updatedAt),
        migrated: migratedAt,
      },
    }

    const labels: string[] = []
    if (status !== 'closed') labels.push(STATUSES[status].label!)
    if (issue.type.key === 'milestone') labels.push(MILESTONE_LABEL)
    const assignee = user(issue.assignee, issue.key)

    return {
      number,
      key: issue.key,
      title: issue.summary,
      body: serializeBody(parsed),
      bodyWithoutLinks: serializeBody({ ...parsed, links: [] }),
      labels,
      assignees: assignee ? [assignee] : [],
      state: status === 'closed' ? 'closed' : 'open',
      status,
      comments,
      parsed,
    }
  })

  // Связь «связана с» симметрична: проверяем, что она записана с обеих сторон.
  const byNumber = new Map(target.map((issue) => [issue.number, issue]))
  for (const issue of target) {
    for (const other of issue.parsed.links) {
      if (!byNumber.get(other)?.parsed.links.includes(issue.number)) {
        warnings.push(`${issue.key}: связь с ${prefix}${other} записана только с одной стороны`)
      }
    }
  }

  return {
    config,
    migratedAt,
    labels: TRACKER_LABELS,
    issues: target,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    missingFiles,
    warnings,
  }
}

export interface TargetStats {
  issues: number
  byStatus: Record<StatusKey, number>
  milestones: number
  assigned: Record<string, number>
  withDescription: number
  comments: number
  checklistItems: number
  checklistChecked: number
  checklistWithAssignee: number
  checklistWithDue: number
  linkRefs: number
  attachmentsInBody: number
  files: number
  missingFiles: number
}

export function targetStats(state: TargetState): TargetStats {
  const stats: TargetStats = {
    issues: state.issues.length,
    byStatus: { open: 0, needInfo: 0, inProgress: 0, closed: 0 },
    milestones: 0,
    assigned: {},
    withDescription: 0,
    comments: 0,
    checklistItems: 0,
    checklistChecked: 0,
    checklistWithAssignee: 0,
    checklistWithDue: 0,
    linkRefs: 0,
    attachmentsInBody: 0,
    files: state.files.length,
    missingFiles: state.missingFiles.length,
  }
  for (const issue of state.issues) {
    stats.byStatus[issue.status] += 1
    if (issue.labels.includes(MILESTONE_LABEL)) stats.milestones += 1
    for (const login of issue.assignees) stats.assigned[login] = (stats.assigned[login] ?? 0) + 1
    if (issue.parsed.description) stats.withDescription += 1
    stats.comments += issue.comments.length
    stats.checklistItems += issue.parsed.checklist.length
    stats.checklistChecked += issue.parsed.checklist.filter((item) => item.checked).length
    stats.checklistWithAssignee += issue.parsed.checklist.filter((item) => item.assignee).length
    stats.checklistWithDue += issue.parsed.checklist.filter((item) => item.due).length
    stats.linkRefs += issue.parsed.links.length
    stats.attachmentsInBody += issue.parsed.attachments.length
  }
  return stats
}

function keyNumber(key: string): number {
  return Number(key.slice(key.lastIndexOf('-') + 1))
}

/** `2026-11-01T15:25:50.312+0000` → ISO 8601 в UTC. */
export function isoDate(value: string): string {
  return new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString()
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}
