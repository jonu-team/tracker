import { labelNames, type GhIssue, type IssuePatch } from './github-types.ts'

/**
 * Статусы как в очереди DEV Яндекс Трекера. «Закрыт» — закрытый issue,
 * остальные — метки на открытом issue. Открытый issue без метки статуса
 * (например, созданный в интерфейсе GitHub) считается «Открыт».
 */
export type StatusKey = 'open' | 'needInfo' | 'inProgress' | 'closed'

export type Tone = 'neutral' | 'info' | 'warning' | 'success'

export interface StatusInfo {
  key: StatusKey
  title: string
  /** Метка GitHub; у «Закрыт» метки нет. */
  label: string | null
  tone: Tone
  /** Название действия в меню переходов. */
  action: string
}

export const STATUSES: Record<StatusKey, StatusInfo> = {
  open: { key: 'open', title: 'Открыт', label: 'Открыт', tone: 'neutral', action: 'Открыть' },
  needInfo: {
    key: 'needInfo',
    title: 'Нужна информация',
    label: 'Нужна информация',
    tone: 'warning',
    action: 'Нужна информация',
  },
  inProgress: { key: 'inProgress', title: 'В работе', label: 'В работе', tone: 'info', action: 'В работу' },
  closed: { key: 'closed', title: 'Закрыт', label: null, tone: 'success', action: 'Закрыть' },
}

export const STATUS_ORDER: StatusKey[] = ['open', 'needInfo', 'inProgress', 'closed']

/** Метки, которые трекер создаёт в репозитории. */
export const TRACKER_LABELS = [
  { name: 'Открыт', color: 'c5cbd3', description: 'Статус: открыта' },
  { name: 'Нужна информация', color: 'fbca04', description: 'Статус: нужна информация' },
  { name: 'В работе', color: '1d76db', description: 'Статус: в работе' },
  { name: 'Веха', color: '8250df', description: 'Тип задачи: веха' },
] as const

export const MILESTONE_LABEL = 'Веха'

const STATUS_LABELS = new Set(STATUS_ORDER.map((key) => STATUSES[key].label).filter(Boolean))

export interface BoardColumn {
  id: 'open' | 'inProgress' | 'closed'
  title: string
  statuses: StatusKey[]
  /** Статус, который получает карточка, перенесённая в колонку. */
  dropStatus: StatusKey
}

/** Колонки доски 1 из Трекера. */
export const BOARD_COLUMNS: BoardColumn[] = [
  { id: 'open', title: 'Открыт', statuses: ['open', 'needInfo'], dropStatus: 'open' },
  { id: 'inProgress', title: 'В работе', statuses: ['inProgress'], dropStatus: 'inProgress' },
  { id: 'closed', title: 'Закрыт', statuses: ['closed'], dropStatus: 'closed' },
]

export function statusOf(issue: Pick<GhIssue, 'state' | 'labels'>): StatusKey {
  if (issue.state === 'closed') return 'closed'
  const labels = new Set(labelNames(issue))
  if (labels.has(STATUSES.inProgress.label!)) return 'inProgress'
  if (labels.has(STATUSES.needInfo.label!)) return 'needInfo'
  return 'open'
}

export function isStatusLabel(name: string): boolean {
  return STATUS_LABELS.has(name)
}

/** Изменения issue для перехода в статус `next`; прочие метки сохраняются. */
export function statusPatch(current: Pick<GhIssue, 'state' | 'labels'>, next: StatusKey): IssuePatch {
  const kept = labelNames(current).filter((name) => !isStatusLabel(name))
  if (next === 'closed') {
    return { state: 'closed', state_reason: 'completed', labels: kept }
  }
  const patch: IssuePatch = { labels: [...kept, STATUSES[next].label!] }
  if (current.state === 'closed') patch.state = 'open'
  return patch
}

export function transitionsFrom(status: StatusKey): StatusKey[] {
  return STATUS_ORDER.filter((key) => key !== status)
}

export function columnOf(status: StatusKey): BoardColumn {
  return BOARD_COLUMNS.find((column) => column.statuses.includes(status))!
}
