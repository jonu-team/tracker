import { commentSafeJson, parseBody, safeJsonObject, type IssueBody } from './body.ts'
import { assigneeLogins, labelNames, type GhComment, type GhIssue } from './github-types.ts'
import { MILESTONE_LABEL, statusOf, type StatusKey } from './status.ts'

/**
 * Перенос пишет в задачу даты из Трекера (`meta`), а GitHub ставит датой
 * изменения момент переноса. Отметка `meta.migrated` уходит последней
 * записью переноса, поэтому `updated_at` отстаёт от неё на секунды; запас —
 * на расхождение часов. Пока задачу не трогали после переноса, показываем
 * дату изменения из Трекера.
 */
const MIGRATION_SETTLE_MS = 5 * 60 * 1000

export interface Person {
  login: string | null
  /** Имя из Трекера для перенесённых записей. */
  name: string | null
}

export interface Issue {
  number: number
  key: string
  title: string
  status: StatusKey
  milestone: boolean
  assignee: string | null
  labels: string[]
  body: IssueBody
  author: Person
  createdAt: string
  updatedAt: string
  closedAt: string | null
  comments: number
  url: string
  raw: GhIssue
}

export function formatKey(prefix: string, number: number): string {
  return `${prefix}-${number}`
}

export function parseKey(prefix: string, text: string): number | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(text.trim())
  if (!match || match[1]!.toUpperCase() !== prefix.toUpperCase()) return null
  return Number(match[2])
}

export function toIssue(gh: GhIssue, prefix: string): Issue {
  const body = parseBody(gh.body)
  const meta = body.meta
  const labels = labelNames(gh)
  const settled =
    meta?.migrated && Date.parse(gh.updated_at) - Date.parse(meta.migrated) <= MIGRATION_SETTLE_MS
  return {
    number: gh.number,
    key: formatKey(prefix, gh.number),
    title: gh.title,
    status: statusOf(gh),
    milestone: labels.includes(MILESTONE_LABEL),
    assignee: assigneeLogins(gh)[0] ?? null,
    labels,
    body,
    author: meta?.author ? { login: null, name: meta.author } : { login: gh.user?.login ?? null, name: null },
    createdAt: meta?.created ?? gh.created_at,
    updatedAt: settled ? (meta.updated ?? gh.updated_at) : gh.updated_at,
    closedAt: gh.closed_at,
    comments: gh.comments,
    url: gh.html_url,
    raw: gh,
  }
}

export interface CommentOrigin {
  id?: string
  author?: string
  created?: string
}

export interface Comment {
  id: number
  text: string
  author: Person
  createdAt: string
  edited: boolean
  /** Комментарий перенесён из Трекера. */
  migrated: boolean
  url: string
  raw: GhComment
}

const ORIGIN_RE = /\s*(?:<sub>[^\n]*<\/sub>\s*)?<!-- tt:origin (\{.*\}) -->\s*$/

/** `tail` — подпись переноса как есть: при правке комментария её возвращаем на место. */
export function parseCommentBody(body: string): { text: string; origin: CommentOrigin | null; tail: string } {
  const match = ORIGIN_RE.exec(body)
  if (!match) return { text: body, origin: null, tail: '' }
  const raw = safeJsonObject(match[1]) ?? {}
  const origin: CommentOrigin = {}
  for (const key of ['id', 'author', 'created'] as const) {
    if (typeof raw[key] === 'string') origin[key] = raw[key]
  }
  return { text: body.slice(0, match.index).trimEnd(), origin, tail: body.slice(match.index) }
}

export function toComment(gh: GhComment): Comment {
  const { text, origin } = parseCommentBody(gh.body)
  return {
    id: gh.id,
    text,
    author: origin?.author ? { login: null, name: origin.author } : { login: gh.user?.login ?? null, name: null },
    createdAt: origin?.created ?? gh.created_at,
    edited: !origin && gh.updated_at !== gh.created_at,
    migrated: Boolean(origin),
    url: gh.html_url,
    raw: gh,
  }
}

/** Комментарий при переносе: текст, видимая в GitHub подпись и машиночитаемый маркер. */
export function migratedCommentBody(text: string, origin: Required<CommentOrigin>, caption: string): string {
  return `${text.trimEnd()}\n\n<sub>${caption}</sub>\n<!-- tt:origin ${commentSafeJson(origin)} -->`
}
