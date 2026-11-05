import { signal } from '@preact/signals'

/**
 * Черновики новых комментариев по задачам. Хранятся в браузере: цитаты
 * собираются по всей странице, и перезагрузка не должна их терять.
 */

const DRAFTS_KEY = 'tracker.drafts'

function load(): Map<number, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, unknown>
    return new Map(
      Object.entries(raw)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, text]) => [Number(key), text]),
    )
  } catch {
    return new Map()
  }
}

export const commentDrafts = signal<ReadonlyMap<number, string>>(load())

/** Растёт при каждой добавленной цитате: поле комментария открывается и получает фокус. */
export const composerFocus = signal(0)

export function draftFor(issue: number): string {
  return commentDrafts.value.get(issue) ?? ''
}

export function setDraft(issue: number, text: string): void {
  const next = new Map(commentDrafts.value)
  if (text.trim()) next.set(issue, text)
  else next.delete(issue)
  commentDrafts.value = next
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(next)))
}

export function forgetDrafts(): void {
  commentDrafts.value = new Map()
  localStorage.removeItem(DRAFTS_KEY)
}

/** Markdown-цитата: каждая строка с `> `, пустые строки — `>`. */
export function toBlockquote(markdown: string): string {
  return markdown
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

/** Цитата в конец черновика; несколько цитат подряд — отдельными блоками. */
export function appendQuote(issue: number, markdown: string): void {
  const quote = toBlockquote(markdown)
  if (!quote) return
  const current = draftFor(issue).replace(/\s+$/, '')
  setDraft(issue, current ? `${current}\n\n${quote}\n\n` : `${quote}\n\n`)
  composerFocus.value += 1
}
