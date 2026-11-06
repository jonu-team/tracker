import { parseBody, type ChecklistItem, type IssueBody } from './body.ts'
import type { GhIssue, GqlIssueActivity, GqlTimelineItem } from './github-types.ts'
import { parseCommentBody, type Person } from './issue.ts'
import { MILESTONE_LABEL, isStatusLabel, statusOf, type StatusKey } from './status.ts'

/**
 * История задачи по данным GitHub: события (метки, исполнители, название,
 * закрытие), версии описания и комментарии. Свой журнал не ведём: GitHub уже
 * хранит всё это, в том числе правки, сделанные прямо в его интерфейсе.
 *
 * Статус, тип и исполнителя восстанавливаем, проигрывая события назад от
 * текущего состояния, — история верна, даже если старые события не
 * поместились в ответ. Правки одного человека подряд (паузы не больше
 * GROUP_GAP_MS) собираются в одну запись с итоговой разницей: снятая метка
 * «Открыт» и поставленная «В работе» — это «Статус: Открыт → В работе», а
 * пункт, отмеченный и тут же снятый, не попадает в историю вовсе.
 */

export type Change =
  | { kind: 'created' }
  | { kind: 'createdInTracker' }
  | { kind: 'migrated' }
  | { kind: 'title'; from: string; to: string }
  // Без `from` — значение при создании задачи.
  | { kind: 'status'; from?: StatusKey; to: StatusKey }
  /** `null` — не назначен. */
  | { kind: 'assignee'; from?: string | null; to: string | null }
  | { kind: 'milestone'; from?: boolean; to: boolean }
  | { kind: 'label'; name: string; added: boolean }
  | { kind: 'description'; from: string; to: string }
  | { kind: 'itemAdded'; text: string }
  | { kind: 'itemRemoved'; text: string }
  | { kind: 'itemChecked'; text: string; checked: boolean }
  | { kind: 'itemText'; from: string; to: string }
  | { kind: 'itemAssignee'; text: string; from: string | null; to: string | null }
  | { kind: 'itemDue'; text: string; from: string | null; to: string | null }
  | { kind: 'itemsReordered' }
  | { kind: 'link'; number: number; added: boolean }
  | { kind: 'attachment'; name: string; added: boolean }
  | { kind: 'comment'; id: number; text: string; url: string }

export interface ActivityEntry {
  /** Не меняется, когда в запись добавляются новые правки того же захода. */
  id: string
  issue: number
  actor: Person
  /** Время последней правки в записи. */
  at: string
  changes: Change[]
  /** Создание в Трекере и перенос: контекст истории, а не новость для уведомлений. */
  historyOnly: boolean
}

export interface IssueHistory {
  number: number
  /** Новые записи первыми. */
  entries: ActivityEntry[]
  /** В ответ поместились не все события или версии описания — показана последняя часть. */
  truncated: boolean
  updatedAt: string
}

/** Правки одного человека с паузами не больше этой — одна запись. */
const GROUP_GAP_MS = 3 * 60 * 1000
/** Метки и исполнитель, которые GitHub записывает событиями в момент создания задачи. */
const CREATION_MS = 10 * 1000
/**
 * Перенос из Трекера пишет в `meta.migrated` время записи тела, а правки
 * людей сохраняют старую отметку. Версия, у которой отметка совпадает со
 * временем правки, — запись переноса.
 */
const MIGRATION_MARK_MS = 2 * 60 * 1000
/** После записи тела перенос ставит метки, публикует комментарии, закрывает задачу. */
const MIGRATION_TAIL_MS = 5 * 60 * 1000
const MIGRATION_LEAD_MS = 10 * 1000

interface IssueState {
  closed: boolean
  labels: readonly string[]
  assignees: readonly string[]
}

type AtomData =
  | { type: 'label'; name: string; added: boolean }
  | { type: 'assignee'; login: string; added: boolean }
  | { type: 'state'; closed: boolean }
  | { type: 'title'; from: string; to: string }
  | { type: 'body'; before: IssueBody; after: IssueBody }
  | { type: 'comment'; id: number; text: string; url: string; migrated: boolean }

/** Одно событие GitHub с состоянием задачи до и после него. */
interface Atom {
  id: string
  iso: string
  at: number
  actor: string | null
  data: AtomData
  before: IssueState
  after: IssueState
}

type RawAtom = Omit<Atom, 'before' | 'after'>

export function buildHistory(activity: GqlIssueActivity): IssueHistory {
  const number = activity.number
  const author = activity.author?.login ?? null
  const created = Date.parse(activity.createdAt)
  const versions = versionsOf(activity)
  const meta = parseBody(activity.body).meta

  const current: IssueState = {
    closed: activity.state === 'CLOSED',
    labels: (activity.labels?.nodes ?? []).map((label) => label.name),
    assignees: activity.assignees.nodes.map((user) => user.login),
  }
  const atoms = replay(
    [...activity.timelineItems.nodes.map(timelineAtom), ...bodyAtoms(versions)]
      .filter((atom): atom is RawAtom => atom !== null && !Number.isNaN(atom.at))
      .sort((a, b) => a.at - b.at),
    current,
  )

  const marks = versions.flatMap((version) => {
    const migrated = Date.parse(version.body.meta?.migrated ?? '')
    return Math.abs(version.at - migrated) <= MIGRATION_MARK_MS ? [version.at] : []
  })
  const migrated = Boolean(meta?.migrated) || marks.length > 0
  if (migrated) marks.push(created)
  const isMigration = (atom: Atom) =>
    (atom.data.type === 'comment' && atom.data.migrated) ||
    (migrated &&
      atom.actor === author &&
      marks.some((mark) => atom.at >= mark - MIGRATION_LEAD_MS && atom.at <= mark + MIGRATION_TAIL_MS))
  const isCreation = (atom: Atom) => !migrated && atom.actor === author && atom.at <= created + CREATION_MS

  const truncated =
    (activity.userContentEdits?.totalCount ?? 0) > (activity.userContentEdits?.nodes.length ?? 0) ||
    activity.timelineItems.totalCount > activity.timelineItems.nodes.length

  const entries: ActivityEntry[] = groupAtoms(atoms.filter((atom) => !isMigration(atom) && !isCreation(atom)))
    .map((group) => ({
      id: `${number}:${group[0]!.id}`,
      issue: number,
      actor: { login: group[0]!.actor, name: null },
      at: group.at(-1)!.iso,
      changes: netChanges(group),
      historyOnly: false,
    }))
    .filter((entry) => entry.changes.length > 0)

  if (migrated) {
    if (meta?.created) {
      entries.push({
        id: `${number}:tracker`,
        issue: number,
        actor: { login: null, name: meta.author ?? null },
        at: meta.created,
        changes: [{ kind: 'createdInTracker' }],
        historyOnly: true,
      })
    }
    entries.push({
      id: `${number}:migrated`,
      issue: number,
      actor: { login: author, name: null },
      at: activity.createdAt,
      changes: [{ kind: 'migrated' }],
      historyOnly: true,
    })
  } else {
    // Начальные статус и исполнитель — состояние после событий создания.
    // Если старые события не поместились в ответ, начального состояния не знаем.
    const creation = atoms.filter(isCreation)
    const initial = creation.at(-1)?.after ?? (truncated ? null : (atoms[0]?.before ?? current))
    entries.push({
      id: `${number}:created`,
      issue: number,
      actor: { login: author, name: null },
      at: activity.createdAt,
      changes: [{ kind: 'created' }, ...(initial ? initialChanges(initial) : [])],
      historyOnly: false,
    })
  }

  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return { number, entries, truncated, updatedAt: activity.updatedAt }
}

/** История для вкладки задачи: комментарии там и так видны. */
export function withoutComments(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return entries
    .map((entry) => ({ ...entry, changes: entry.changes.filter((change) => change.kind !== 'comment') }))
    .filter((entry) => entry.changes.length > 0)
}

/** Что изменилось в теле задачи: описание, чеклист, связи, вложения. Служебные отметки не в счёт. */
export function bodyChanges(before: IssueBody, after: IssueBody): Change[] {
  const changes: Change[] = []
  if (before.description.trim() !== after.description.trim()) {
    changes.push({ kind: 'description', from: before.description.trim(), to: after.description.trim() })
  }
  changes.push(...checklistChanges(before.checklist, after.checklist))
  for (const number of after.links) if (!before.links.includes(number)) changes.push({ kind: 'link', number, added: true })
  for (const number of before.links) if (!after.links.includes(number)) changes.push({ kind: 'link', number, added: false })
  const urls = (body: IssueBody) => new Set(body.attachments.map((file) => file.url))
  const beforeUrls = urls(before)
  const afterUrls = urls(after)
  for (const file of after.attachments) if (!beforeUrls.has(file.url)) changes.push({ kind: 'attachment', name: file.name, added: true })
  for (const file of before.attachments) if (!afterUrls.has(file.url)) changes.push({ kind: 'attachment', name: file.name, added: false })
  return changes
}

function checklistChanges(before: readonly ChecklistItem[], after: readonly ChecklistItem[]): Change[] {
  const free = new Set(before.keys())
  const take = (match: (item: ChecklistItem) => boolean): number | undefined => {
    const index = before.findIndex((item, i) => free.has(i) && match(item))
    if (index < 0) return undefined
    free.delete(index)
    return index
  }
  // Сначала по id; пункты без id (добавлены в интерфейсе GitHub) — по тексту.
  const pairs = after.map((item) => ({ item, from: item.id ? take((old) => old.id === item.id) : undefined }))
  for (const pair of pairs) pair.from ??= take((old) => old.text === pair.item.text)

  const changes: Change[] = []
  const order = pairs.flatMap((pair) => (pair.from === undefined ? [] : [pair.from]))
  if (order.some((index, i) => i > 0 && index < order[i - 1]!)) changes.push({ kind: 'itemsReordered' })
  for (const { item, from } of pairs) {
    const old = from === undefined ? undefined : before[from]
    if (!old) {
      changes.push({ kind: 'itemAdded', text: item.text })
      continue
    }
    if (old.text !== item.text) changes.push({ kind: 'itemText', from: old.text, to: item.text })
    if (old.checked !== item.checked) changes.push({ kind: 'itemChecked', text: item.text, checked: item.checked })
    if ((old.assignee ?? null) !== (item.assignee ?? null)) {
      changes.push({ kind: 'itemAssignee', text: item.text, from: old.assignee ?? null, to: item.assignee ?? null })
    }
    if ((old.due ?? null) !== (item.due ?? null)) {
      changes.push({ kind: 'itemDue', text: item.text, from: old.due ?? null, to: item.due ?? null })
    }
  }
  for (const index of free) changes.push({ kind: 'itemRemoved', text: before[index]!.text })
  return changes
}

interface Version {
  id: string
  iso: string
  at: number
  editor: string | null
  body: IssueBody
}

/** Версии тела от старой к новой. Без правок — одна версия: текущее тело. */
function versionsOf(activity: GqlIssueActivity): Version[] {
  const versions = (activity.userContentEdits?.nodes ?? [])
    .filter((edit) => edit.diff !== null && !edit.deletedAt)
    .map((edit) => ({
      id: edit.id,
      iso: edit.editedAt,
      at: Date.parse(edit.editedAt),
      editor: edit.editor?.login ?? null,
      body: parseBody(edit.diff),
    }))
    .sort((a, b) => a.at - b.at)
  if (versions.length) return versions
  const { createdAt, author, body } = activity
  return [{ id: 'body', iso: createdAt, at: Date.parse(createdAt), editor: author?.login ?? null, body: parseBody(body) }]
}

/** Каждая версия, кроме самой старой из полученных, — правка относительно предыдущей. */
function bodyAtoms(versions: Version[]): RawAtom[] {
  return versions.slice(1).map((version, index) => ({
    id: version.id,
    iso: version.iso,
    at: version.at,
    actor: version.editor,
    data: { type: 'body', before: versions[index]!.body, after: version.body },
  }))
}

function timelineAtom(item: GqlTimelineItem): RawAtom | null {
  const base = { id: item.id, iso: item.createdAt, at: Date.parse(item.createdAt) }
  switch (item.__typename) {
    case 'LabeledEvent':
    case 'UnlabeledEvent':
      return { ...base, actor: item.actor?.login ?? null, data: { type: 'label', name: item.label.name, added: item.__typename === 'LabeledEvent' } }
    case 'AssignedEvent':
    case 'UnassignedEvent':
      if (!item.assignee?.login) return null
      return {
        ...base,
        actor: item.actor?.login ?? null,
        data: { type: 'assignee', login: item.assignee.login, added: item.__typename === 'AssignedEvent' },
      }
    case 'ClosedEvent':
    case 'ReopenedEvent':
      return { ...base, actor: item.actor?.login ?? null, data: { type: 'state', closed: item.__typename === 'ClosedEvent' } }
    case 'RenamedTitleEvent':
      return { ...base, actor: item.actor?.login ?? null, data: { type: 'title', from: item.previousTitle, to: item.currentTitle } }
    case 'IssueComment': {
      const { text, origin } = parseCommentBody(item.body)
      return {
        ...base,
        actor: item.author?.login ?? null,
        data: { type: 'comment', id: item.databaseId, text, url: item.url, migrated: Boolean(origin) },
      }
    }
    default:
      return null
  }
}

/** Проигрывает события назад от текущего состояния: у каждого — состояние до и после. */
function replay(raw: RawAtom[], current: IssueState): Atom[] {
  const atoms = new Array<Atom>(raw.length)
  let state = current
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const atom = raw[i]!
    const before = undo(atom.data, state)
    atoms[i] = { ...atom, before, after: state }
    state = before
  }
  return atoms
}

function undo(data: AtomData, state: IssueState): IssueState {
  switch (data.type) {
    case 'label':
      return { ...state, labels: toggle(state.labels, data.name, !data.added) }
    case 'assignee':
      return { ...state, assignees: toggle(state.assignees, data.login, !data.added) }
    case 'state':
      return { ...state, closed: !data.closed }
    default:
      return state
  }
}

function toggle(list: readonly string[], value: string, present: boolean): string[] {
  const without = list.filter((item) => item !== value)
  return present ? [...without, value] : without
}

function groupAtoms(atoms: Atom[]): Atom[][] {
  const groups: Atom[][] = []
  for (const atom of atoms) {
    const group = groups.at(-1)
    const last = group?.at(-1)
    if (group && last && last.actor === atom.actor && atom.at - last.at <= GROUP_GAP_MS) group.push(atom)
    else groups.push([atom])
  }
  return groups
}

/** Итог захода: состояние до первой правки против состояния после последней. */
function netChanges(group: Atom[]): Change[] {
  const changes: Change[] = []
  const titles = group.flatMap((atom) => (atom.data.type === 'title' ? [atom.data] : []))
  const firstTitle = titles[0]
  const lastTitle = titles.at(-1)
  if (firstTitle && lastTitle && firstTitle.from !== lastTitle.to) changes.push({ kind: 'title', from: firstTitle.from, to: lastTitle.to })

  changes.push(...stateChanges(group[0]!.before, group.at(-1)!.after))

  const bodies = group.flatMap((atom) => (atom.data.type === 'body' ? [atom.data] : []))
  const firstBody = bodies[0]
  const lastBody = bodies.at(-1)
  if (firstBody && lastBody) changes.push(...bodyChanges(firstBody.before, lastBody.after))

  for (const atom of group) {
    if (atom.data.type === 'comment') changes.push({ kind: 'comment', id: atom.data.id, text: atom.data.text, url: atom.data.url })
  }
  return changes
}

function stateChanges(before: IssueState, after: IssueState): Change[] {
  const changes: Change[] = []
  const from = statusOf(asIssue(before))
  const to = statusOf(asIssue(after))
  if (from !== to) changes.push({ kind: 'status', from, to })
  if (!sameSet(before.assignees, after.assignees)) {
    changes.push({ kind: 'assignee', from: before.assignees[0] ?? null, to: after.assignees[0] ?? null })
  }
  const wasMilestone = before.labels.includes(MILESTONE_LABEL)
  const isMilestone = after.labels.includes(MILESTONE_LABEL)
  if (wasMilestone !== isMilestone) changes.push({ kind: 'milestone', from: wasMilestone, to: isMilestone })
  for (const name of after.labels) if (isPlainLabel(name) && !before.labels.includes(name)) changes.push({ kind: 'label', name, added: true })
  for (const name of before.labels) if (isPlainLabel(name) && !after.labels.includes(name)) changes.push({ kind: 'label', name, added: false })
  return changes
}

function initialChanges(state: IssueState): Change[] {
  const changes: Change[] = []
  const status = statusOf(asIssue(state))
  if (status !== 'open') changes.push({ kind: 'status', to: status })
  if (state.assignees[0]) changes.push({ kind: 'assignee', to: state.assignees[0] })
  if (state.labels.includes(MILESTONE_LABEL)) changes.push({ kind: 'milestone', to: true })
  return changes
}

function asIssue(state: IssueState): Pick<GhIssue, 'state' | 'labels'> {
  return { state: state.closed ? 'closed' : 'open', labels: [...state.labels] }
}

function isPlainLabel(name: string): boolean {
  return !isStatusLabel(name) && name !== MILESTONE_LABEL
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item))
}
