import { normalizeNewlines } from '../../src/domain/body.ts'

/**
 * Перевод разметки Яндекс Трекера (YFM) в GitHub Flavored Markdown.
 *
 * Очередь DEV написана почти чистым CommonMark, отличия точечные:
 * - картинки-вложения `![x](/ajax/v2/attachments/12?inline=true =800x600)` —
 *   GitHub не поймёт ни путь, ни размер после пробела;
 * - Трекер показывает HTML-теги текстом, а GitHub их исполняет или вырезает —
 *   экранируем всё, что вне кода;
 * - отметки `[x] текст` без маркера списка — в YFM это чекбокс, в GFM нет;
 * - голые `#123` в GitHub станут ссылкой на issue этого репозитория — в
 *   задачах так ссылались на PR репозитория с кодом;
 * - ссылки на задачи очереди в Трекере ведут в платный Трекер — переводим
 *   их на issue того же номера: голый адрес → `#14`, ссылка → адрес issue;
 * - `@логин` из Трекера в GitHub упомянул бы постороннего человека.
 * Код (блоки и `инлайн`) не трогаем.
 */

export interface AttachmentTarget {
  url: string
  /** Пояснение рядом с картинкой, например «только миниатюра». */
  note?: string
}

export interface YfmContext {
  /** Файл вложения в репозитории или null, если файла нет. */
  attachment(id: string): AttachmentTarget | null
  /** Текст вместо вложения, которое не удалось перенести. */
  missing(id: string, name: string): string
  /** Репозиторий `owner/name`, на PR которого указывают голые `#123`. */
  hashRefRepo?: string
  /** Очередь Трекера (`DEV`): её задачи переносятся в issue с тем же номером. */
  queue?: string
  /** Адрес issue с номером `n` — для ссылок `[текст](адрес задачи в Трекере)`. */
  issueUrl?: (number: number) => string
}

export interface YfmResult {
  markdown: string
  /** id вложений, встроенных в текст. */
  attachments: string[]
  warnings: string[]
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/
const CHECKBOX_RE = /^(\s*)\[([ xX])\](\s+)/
const ATTACHMENT_PATH_RE = /^\/ajax\/v2\/attachments\/(\d+)/

const INLINE_RE = new RegExp(
  [
    // код в строке: одинаковые серии обратных кавычек
    String.raw`(?<code>(\`+)[\s\S]*?[^\`]\2(?!\`))`,
    // ссылка или картинка, в том числе с размером YFM после пробела
    String.raw`(?<link>!?\[(?:[^\[\]\\]|\\.|\[[^\[\]]*\])*\]\([^()\s]*(?:\([^()\s]*\)[^()\s]*)*(?:\s+[^)]*)?\))`,
    String.raw`(?<autolink><(?:https?|mailto|ftp):[^>\s]*>)`,
    String.raw`(?<url>https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)`,
    String.raw`(?<html><\/?[A-Za-z][^>]*>|<!--)`,
    String.raw`(?<hashref>(?<![\w&#/])#\d+\b)`,
    String.raw`(?<mention>(?<![\w.\`@])@[A-Za-z0-9][\w.-]*)`,
  ].join('|'),
  'g',
)

const LINK_PARTS_RE = /^(!?)\[([\s\S]*)\]\((\S*?)(\s+[^)]*)?\)$/
const TRACKER_ISSUE_RE = /^https?:\/\/tracker\.yandex\.ru\/([A-Z][A-Z0-9]*)-(\d+)\/?$/

const YFM_ONLY: [RegExp, string][] = [
  [/\{%\s*(cut|note|list|include)/, 'блоки {% … %}'],
  [/^#\|/m, 'таблицы #| … |#'],
  [/!!\([a-z]+\)/, 'цветной текст !!(…)'],
  [/\+\+[^+\n]+\+\+/, 'подчёркивание ++…++'],
]

export function yfmToGfm(source: string, ctx: YfmContext): YfmResult {
  const used = new Set<string>()
  const warnings: string[] = []
  const out: string[] = []
  let text: string[] = []
  let fence: { char: string; length: number } | null = null

  const flush = () => {
    if (!text.length) return
    out.push(convertInline(text.join('\n'), ctx, used))
    text = []
  }

  for (const line of normalizeNewlines(source).split('\n')) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fence) {
      out.push(line)
      const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (closing && closing[1]![0] === fence.char && closing[1]!.length >= fence.length) fence = null
      continue
    }
    if (fenceMatch) {
      flush()
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length }
      out.push(line)
      continue
    }
    text.push(line.replace(CHECKBOX_RE, '$1- [$2]$3'))
  }
  flush()

  for (const [pattern, name] of YFM_ONLY) {
    if (pattern.test(source)) warnings.push(`разметка YFM без аналога в GitHub: ${name}`)
  }
  return { markdown: out.join('\n').trim(), attachments: [...used], warnings }
}

function convertInline(text: string, ctx: YfmContext, used: Set<string>): string {
  return text.replace(INLINE_RE, (match, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>
    if (groups.link) return convertLink(match, ctx, used)
    if (groups.html) return `&lt;${match.slice(1)}`
    if (groups.hashref && ctx.hashRefRepo) {
      const number = match.slice(1)
      return `[#${number}](https://github.com/${ctx.hashRefRepo}/pull/${number})`
    }
    if (groups.mention) return `@&#8203;${match.slice(1)}`
    if (groups.url) {
      const number = queueIssue(match, ctx)
      if (number !== null) return `#${number}`
    }
    return match
  })
}

function queueIssue(url: string, ctx: YfmContext): number | null {
  const match = TRACKER_ISSUE_RE.exec(url)
  return match && ctx.queue && match[1] === ctx.queue ? Number(match[2]) : null
}

function convertLink(match: string, ctx: YfmContext, used: Set<string>): string {
  const parts = LINK_PARTS_RE.exec(match)
  if (!parts) return match
  const issue = queueIssue(parts[3] ?? '', ctx)
  if (issue !== null && ctx.issueUrl) return `${parts[1]}[${parts[2]}](${ctx.issueUrl(issue)}${parts[4] ?? ''})`
  const id = ATTACHMENT_PATH_RE.exec(parts[3] ?? '')?.[1]
  if (!id) return match
  used.add(id)
  const [, bang, label] = parts
  const target = ctx.attachment(id)
  if (!target) return ctx.missing(id, label || `вложение ${id}`)
  const link = `${bang}[${label}](${target.url})`
  return target.note ? `${link} _(${target.note})_` : link
}
