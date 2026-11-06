const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
const fullDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
const fullDateTime = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** «сегодня, 14:30», «вчера, 09:12», «12 окт.», «12 окт. 2025 г.». */
export function formatDate(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return `сегодня, ${time.format(date)}`
  if (days === 1) return `вчера, ${time.format(date)}`
  return date.getFullYear() === now.getFullYear() ? dayMonth.format(date) : fullDate.format(date)
}

const dayLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const dayLongYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })

/** Заголовок дня в ленте: «Сегодня», «Вчера», «4 ноября», «4 ноября 2025 г.». */
export function formatDay(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return 'Сегодня'
  if (days === 1) return 'Вчера'
  return date.getFullYear() === now.getFullYear() ? dayLong.format(date) : dayLongYear.format(date)
}

/** «14:30». */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : time.format(date)
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : fullDateTime.format(date)
}

/** Срок пункта чеклиста: `2026-11-10` → «10 нояб.». */
export function formatDue(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  const date = new Date(y, m - 1, d)
  return y === now.getFullYear() ? dayMonth.format(date) : fullDate.format(date)
}

export function isOverdue(day: string, now = new Date()): boolean {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return false
  return new Date(y, m - 1, d).getTime() < startOfDay(now)
}

const plural = new Intl.PluralRules('ru-RU')

/** pluralize(5, ['задача', 'задачи', 'задач']) → «5 задач». */
export function pluralize(count: number, [one, few, many]: [string, string, string]): string {
  const form = plural.select(count)
  return `${count} ${form === 'one' ? one : form === 'few' ? few : many}`
}
