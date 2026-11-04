/**
 * Тело issue в GitHub — один markdown-текст. Сверху описание задачи, ниже
 * служебные секции. Каждая секция начинается строкой-маркером
 * `<!-- tt:<имя> -->`: GitHub маркер не показывает, а содержимое секции
 * рендерит как обычный markdown, поэтому задача читается и в самом GitHub.
 *
 *   <описание>
 *
 *   <!-- tt:checklist -->
 *   ### Чеклист
 *
 *   - [x] Пункт <!-- {"id":"a1b2c3d4","assignee":"login","due":"2026-11-10"} -->
 *
 *   <!-- tt:links -->
 *   **Связана с:** #31, #32
 *
 *   <!-- tt:attachments -->
 *   ### Вложения
 *
 *   ![image.png](https://github.com/<owner>/<repo>/blob/main/attachments/DEV-1/1-image.png?raw=true)
 *
 *   <!-- tt:meta {"key":"DEV-1","created":"…","updated":"…","author":"…","migrated":"…"} -->
 *
 * Разбор терпим к ручным правкам в интерфейсе GitHub: строки, которые не
 * подходят под формат секции, переезжают в описание, а не теряются.
 */

export interface ChecklistItem {
  /** Пустая строка — пункт добавлен вручную в GitHub, id выдадим при записи. */
  id: string
  text: string
  checked: boolean
  /** Логин GitHub. */
  assignee?: string
  /** Срок в формате YYYY-MM-DD. */
  due?: string
}

export interface Attachment {
  name: string
  url: string
}

/** Сведения о задаче из Яндекс Трекера, записанные при переносе. */
export interface IssueMeta {
  key?: string
  author?: string
  created?: string
  updated?: string
  migrated?: string
}

export interface IssueBody {
  description: string
  checklist: ChecklistItem[]
  /** Номера связанных issue в этом же репозитории. */
  links: number[]
  attachments: Attachment[]
  meta: IssueMeta | null
  /** Секции с незнакомыми маркерами: сохраняем дословно. */
  unknown: string[]
}

export const SECTION_TITLES = {
  checklist: 'Чеклист',
  links: 'Связана с',
  attachments: 'Вложения',
} as const

const MARKER_RE = /^<!-- tt:([a-z]+)(?: (\{.*\}))? -->$/
const ITEM_RE = /^\s*[-*+]\s+\[([ xX])\](?:\s+(.*))?$/
const ITEM_META_RE = /\s*<!--\s*(\{.*\})\s*-->\s*$/
const HEADING_RE = /^#{1,6}\s+(.*?)\s*#*\s*$/
const LINK_REF_RE = /(?:^|[^\w&/])(?:#|[A-Z][A-Z0-9]*-)(\d+)\b/g
const MD_LINK_RE = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\(([^)\s]+)\)/g
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function emptyBody(): IssueBody {
  return { description: '', checklist: [], links: [], attachments: [], meta: null, unknown: [] }
}

interface RawSection {
  name: string
  json: string | undefined
  lines: string[]
}

export function parseBody(raw: string | null | undefined): IssueBody {
  const body = emptyBody()
  const description: string[] = []
  const stray: string[] = []
  const sections: RawSection[] = []
  let current: RawSection | null = null

  for (const line of normalizeNewlines(raw ?? '').split('\n')) {
    const marker = MARKER_RE.exec(line.trim())
    if (marker) {
      current = { name: marker[1]!, json: marker[2], lines: [] }
      sections.push(current)
    } else {
      ;(current ? current.lines : description).push(line)
    }
  }

  for (const section of sections) {
    switch (section.name) {
      case 'checklist':
        body.checklist.push(...parseChecklist(section.lines, stray))
        break
      case 'links':
        for (const n of parseLinks(section.lines, stray)) {
          if (!body.links.includes(n)) body.links.push(n)
        }
        break
      case 'attachments':
        body.attachments.push(...parseAttachments(section.lines, stray))
        break
      case 'meta':
        body.meta = parseMeta(section.json)
        stray.push(...section.lines)
        break
      default:
        body.unknown.push(
          [`<!-- tt:${section.name}${section.json ? ` ${section.json}` : ''} -->`, ...section.lines]
            .join('\n')
            .trim(),
        )
    }
  }

  body.description = [description.join('\n').trim(), stray.join('\n').trim()].filter(Boolean).join('\n\n')
  return body
}

export function serializeBody(body: IssueBody): string {
  const parts: string[] = []
  const description = body.description.trim()
  if (description) parts.push(description)

  if (body.checklist.length) {
    parts.push(
      ['<!-- tt:checklist -->', `### ${SECTION_TITLES.checklist}`, '', ...body.checklist.map(serializeItem)].join('\n'),
    )
  }
  if (body.links.length) {
    const refs = [...new Set(body.links)].sort((a, b) => a - b).map((n) => `#${n}`)
    parts.push(['<!-- tt:links -->', `**${SECTION_TITLES.links}:** ${refs.join(', ')}`].join('\n'))
  }
  if (body.attachments.length) {
    const files = body.attachments.map(
      (file) => `${isImageName(file.name) ? '!' : ''}[${escapeLinkText(file.name)}](${file.url})`,
    )
    parts.push(['<!-- tt:attachments -->', `### ${SECTION_TITLES.attachments}`, '', files.join('\n\n')].join('\n'))
  }
  parts.push(...body.unknown)
  if (body.meta && Object.keys(body.meta).length) {
    parts.push(`<!-- tt:meta ${commentSafeJson(body.meta)} -->`)
  }
  return parts.join('\n\n')
}

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name)
}

/** Короткий случайный id пункта чеклиста. */
export function newItemId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Выдаёт id пунктам, добавленным вручную в GitHub. */
export function withItemIds(body: IssueBody): IssueBody {
  if (body.checklist.every((item) => item.id)) return body
  return { ...body, checklist: body.checklist.map((item) => (item.id ? item : { ...item, id: newItemId() })) }
}

export function checklistProgress(items: readonly ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.checked).length, total: items.length }
}

function parseChecklist(lines: string[], stray: string[]): ChecklistItem[] {
  const items: ChecklistItem[] = []
  let headingSeen = false
  for (const line of lines) {
    if (!line.trim()) continue
    const heading = HEADING_RE.exec(line.trim())
    if (heading && !headingSeen && heading[1] === SECTION_TITLES.checklist) {
      headingSeen = true
      continue
    }
    const match = ITEM_RE.exec(line)
    if (!match) {
      stray.push(line)
      continue
    }
    let text = match[2] ?? ''
    let meta: Record<string, unknown> = {}
    const metaMatch = ITEM_META_RE.exec(text)
    if (metaMatch) {
      meta = safeJsonObject(metaMatch[1]) ?? {}
      text = text.slice(0, metaMatch.index)
    }
    const item: ChecklistItem = { id: stringOr(meta.id) ?? '', text: text.trim(), checked: match[1] !== ' ' }
    const assignee = stringOr(meta.assignee)
    if (assignee) item.assignee = assignee
    const due = stringOr(meta.due)
    if (due && DATE_RE.test(due)) item.due = due
    items.push(item)
  }
  return items
}

function serializeItem(item: ChecklistItem): string {
  const meta: Record<string, string> = {}
  if (item.id) meta.id = item.id
  if (item.assignee) meta.assignee = item.assignee
  if (item.due) meta.due = item.due
  const text = item.text.replace(/\s*\n\s*/g, ' ').replace(/<!--/g, '&lt;!--').trim()
  const suffix = Object.keys(meta).length ? ` <!-- ${commentSafeJson(meta)} -->` : ''
  return `- [${item.checked ? 'x' : ' '}] ${text}${suffix}`
}

function parseLinks(lines: string[], stray: string[]): number[] {
  const numbers: number[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const found = [...line.matchAll(LINK_REF_RE)].map((m) => Number(m[1]))
    if (found.length) numbers.push(...found)
    else stray.push(line)
  }
  return numbers
}

function parseAttachments(lines: string[], stray: string[]): Attachment[] {
  const files: Attachment[] = []
  let headingSeen = false
  for (const line of lines) {
    if (!line.trim()) continue
    const heading = HEADING_RE.exec(line.trim())
    if (heading && !headingSeen && heading[1] === SECTION_TITLES.attachments) {
      headingSeen = true
      continue
    }
    const found = [...line.matchAll(MD_LINK_RE)]
    if (!found.length) {
      stray.push(line)
      continue
    }
    for (const m of found) files.push({ name: unescapeLinkText(m[2] ?? ''), url: m[3] ?? '' })
  }
  return files
}

function parseMeta(json: string | undefined): IssueMeta {
  const raw = safeJsonObject(json) ?? {}
  const meta: IssueMeta = {}
  for (const key of ['key', 'author', 'created', 'updated', 'migrated'] as const) {
    const value = stringOr(raw[key])
    if (value) meta[key] = value
  }
  return meta
}

/** JSON внутри HTML-комментария: `--` и `>` экранируем, чтобы комментарий не закрылся раньше. */
export function commentSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/-(?=-)/g, '\\u002d').replace(/>/g, '\\u003e')
}

export function safeJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function escapeLinkText(text: string): string {
  return text.replace(/([\\\[\]])/g, '\\$1')
}

function unescapeLinkText(text: string): string {
  return text.replace(/\\([\\\[\]])/g, '$1')
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}
