import { batch, computed, signal } from '@preact/signals'
import { KEY_PREFIX, forgetToken, storeRepo, storeToken, storedRepo, storedToken } from './config.ts'
import { buildHistory, type ActivityEntry, type IssueHistory } from './domain/activity.ts'
import { emptyBody, isImageName, parseBody, serializeBody, withItemIds, type IssueBody } from './domain/body.ts'
import { addLink, removeLink } from './domain/edits.ts'
import { labelNames, type GhIssue, type GqlIssueActivity, type IssuePatch } from './domain/github-types.ts'
import { parseCommentBody, toComment, toIssue, type Comment, type Issue } from './domain/issue.ts'
import { MILESTONE_LABEL, STATUSES, statusOf, statusPatch, type StatusKey } from './domain/status.ts'
import { MAX_UPLOAD_BYTES, fileToBase64, forgetRepoFiles, repoFileUrl, safeFileName } from './lib/files.ts'
import { GitHubClient, GitHubError, parseRepoRef, repoRefString, type RepoRef } from './lib/github.ts'

export interface UserInfo {
  login: string
  name: string | null
}

export interface Session {
  client: GitHubClient
  repo: RepoRef
  branch: string
  viewer: UserInfo
  demo: boolean
}

export const session = signal<Session | null>(null)
/** Идёт проверка сохранённого токена при старте. */
export const booting = signal(true)
export const issueMap = signal<ReadonlyMap<number, Issue>>(new Map())
export const issues = computed(() => [...issueMap.value.values()])
export const users = signal<ReadonlyMap<string, UserInfo>>(new Map())
export const sync = signal<{ loading: boolean; error: string | null; at: number }>({ loading: false, error: null, at: 0 })
/** Задачи, у которых есть несохранённые правки. */
export const savingIssues = signal<ReadonlySet<number>>(new Set())

// Уведомления

export interface Toast {
  id: number
  text: string
  tone: 'error' | 'info'
}

export const toasts = signal<Toast[]>([])
let toastSeq = 0

export function notify(text: string, tone: Toast['tone'] = 'info'): void {
  const id = ++toastSeq
  toasts.value = [...toasts.value, { id, text, tone }]
  setTimeout(() => dismissToast(id), tone === 'error' ? 8000 : 4000)
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Что-то пошло не так'
}

// Вход и выход

export async function restoreSession(): Promise<void> {
  try {
    // Демо-режим есть только в dev-сервере (`npm run demo`). Условие записано
    // прямо здесь, чтобы сборщик выбросил демо-модуль из продакшн-сборки.
    if (import.meta.env.DEV && import.meta.env.MODE === 'demo') {
      const { createDemoBackend } = await import('./lib/demo.ts')
      const demo = await createDemoBackend()
      // Проверка уведомлений в демо: `__demo.actAs('логин')` в консоли — дальнейшие
      // правки уйдут от имени этого человека; `__demo.actAs(null)` — снова от своего.
      Object.assign(globalThis, { __demo: { actAs: demo.actAs } })
      await open(new GitHubClient({ token: demo.token, repo: demo.repo, fetch: demo.fetch }), true)
      return
    }
    const token = storedToken()
    const repo = parseRepoRef(storedRepo())
    if (token && repo) await open(new GitHubClient({ token, repo, revalidate: true }), false)
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) forgetToken()
    notify(errorText(error), 'error')
  } finally {
    booting.value = false
  }
}

export async function signIn(token: string, repoText: string): Promise<void> {
  const repo = parseRepoRef(repoText)
  if (!repo) throw new Error('Репозиторий укажите в виде owner/name, например my-org/tasks.')
  const clean = token.trim()
  await open(new GitHubClient({ token: clean, repo, revalidate: true }), false)
  storeToken(clean)
  storeRepo(repoRefString(repo))
}

export function signOut(): void {
  stopPolling()
  forgetToken()
  forgetRepoFiles()
  serverIssues.clear()
  pendingOps.clear()
  historyLoads.clear()
  feedWatermark = 0
  batch(() => {
    session.value = null
    issueMap.value = new Map()
    users.value = new Map()
    commentsByIssue.value = new Map()
    savingIssues.value = new Set()
    activityByIssue.value = new Map()
    feed.value = { status: 'idle' }
    seenAt.value = 0
  })
}

async function open(client: GitHubClient, demo: boolean): Promise<void> {
  const [viewer, repository] = await Promise.all([
    client.viewer(),
    client.repository().catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) {
        throw new GitHubError(
          404,
          `Токен не видит ${repoRefString(client.repo)}. Проверьте, что в токене выбран этот репозиторий; ` +
            'если вы участник, а не владелец организации, — что владелец одобрил токен.',
        )
      }
      throw error
    }),
  ])
  if (!repository.has_issues) throw new Error(`В репозитории ${repository.full_name} выключены Issues.`)
  const current: Session = {
    client,
    repo: client.repo,
    branch: repository.default_branch,
    viewer: { login: viewer.login, name: viewer.name ?? null },
    demo,
  }
  await loadIssues(client)
  restoreSeen(current.viewer.login)
  session.value = current
  void loadUsers(current)
  void syncFeed(current)
  startPolling()
}

function requireSession(): Session {
  const current = session.value
  if (!current) throw new Error('Нет входа')
  return current
}

async function loadUsers(current: Session): Promise<void> {
  const known = new Map<string, UserInfo>([[current.viewer.login, current.viewer]])
  try {
    const list = await current.client.assignees()
    const named = await Promise.all(
      list.map(async (user) => {
        if (user.login === current.viewer.login) return current.viewer
        try {
          const full = await current.client.user(user.login)
          return { login: user.login, name: full.name ?? null }
        } catch {
          return { login: user.login, name: null }
        }
      }),
    )
    for (const user of named) known.set(user.login, user)
  } finally {
    users.value = known
  }
}

export function displayName(login: string | null | undefined): string {
  if (!login) return ''
  return users.value.get(login)?.name || login
}

// Синхронизация

/**
 * Состояние задачи на экране = последний ответ сервера + ещё не записанные
 * правки. Так отклик мгновенный, а ответы сервера и фоновое обновление
 * не «откатывают» правки, которые ещё в пути.
 */
const serverIssues = new Map<number, GhIssue>()
const pendingOps = new Map<number, ((issue: Issue) => Issue)[]>()

function derive(gh: GhIssue): Issue {
  let issue = toIssue(gh, KEY_PREFIX)
  for (const op of pendingOps.get(gh.number) ?? []) issue = op(issue)
  return issue
}

function recompute(number: number): void {
  const gh = serverIssues.get(number)
  if (!gh) return
  const next = new Map(issueMap.value)
  next.set(number, derive(gh))
  issueMap.value = next
}

function acceptServer(gh: GhIssue): void {
  serverIssues.set(gh.number, gh)
  recompute(gh.number)
}

async function loadIssues(client: GitHubClient): Promise<void> {
  sync.value = { ...sync.value, loading: true }
  try {
    const list = await client.issues()
    serverIssues.clear()
    const next = new Map<number, Issue>()
    for (const gh of list) {
      serverIssues.set(gh.number, gh)
      next.set(gh.number, derive(gh))
    }
    batch(() => {
      issueMap.value = next
      sync.value = { loading: false, error: null, at: Date.now() }
    })
  } catch (error) {
    sync.value = { loading: false, error: errorText(error), at: sync.value.at }
    throw error
  }
}

export async function refresh(): Promise<void> {
  const current = session.value
  if (!current || sync.value.loading) return
  try {
    await loadIssues(current.client)
    void syncFeed(current)
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) {
      signOut()
      notify('Токен больше не действует — войдите заново.', 'error')
    }
  }
}

const POLL_MS = 60_000
const REFOCUS_MS = 15_000
let pollTimer: ReturnType<typeof setInterval> | undefined

function onVisibility(): void {
  if (document.visibilityState === 'visible' && Date.now() - sync.value.at > REFOCUS_MS) void refresh()
}

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
}

function stopPolling(): void {
  clearInterval(pollTimer)
  document.removeEventListener('visibilitychange', onVisibility)
}

// Запись

/** Записи в одну задачу идут по очереди: каждая читает результат предыдущей. */
const writeQueues = new Map<number, Promise<unknown>>()

function enqueue<T>(number: number, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(number) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(number, tail)
  void tail.then(() => {
    if (writeQueues.get(number) === tail) writeQueues.delete(number)
  })
  return run
}

function setPending(number: number, op: (issue: Issue) => Issue, add: boolean): void {
  const ops = pendingOps.get(number) ?? []
  const next = add ? [...ops, op] : ops.filter((candidate) => candidate !== op)
  if (next.length) pendingOps.set(number, next)
  else pendingOps.delete(number)
  const saving = new Set(savingIssues.value)
  if (next.length) saving.add(number)
  else saving.delete(number)
  savingIssues.value = saving
}

/**
 * Правка задачи: `local` — мгновенно на экране, `patch` — по свежей версии
 * с сервера (null — менять нечего).
 */
async function writeIssue(
  number: number,
  local: (issue: Issue) => Issue,
  patch: (fresh: GhIssue) => IssuePatch | null,
): Promise<boolean> {
  const current = requireSession()
  setPending(number, local, true)
  recompute(number)
  return enqueue(number, async () => {
    try {
      const fresh = await current.client.issue(number)
      serverIssues.set(number, fresh)
      const change = patch(fresh)
      if (change) serverIssues.set(number, await current.client.updateIssue(number, change))
      return true
    } catch (error) {
      notify(`Не сохранилось: ${errorText(error)}`, 'error')
      return false
    } finally {
      setPending(number, local, false)
      recompute(number)
    }
  })
}

export function setStatus(number: number, status: StatusKey): Promise<boolean> {
  return writeIssue(
    number,
    (issue) => ({ ...issue, status }),
    (fresh) => (statusOf(fresh) === status ? null : statusPatch(fresh, status)),
  )
}

export function setAssignee(number: number, login: string | null): Promise<boolean> {
  return writeIssue(
    number,
    (issue) => ({ ...issue, assignee: login }),
    () => ({ assignees: login ? [login] : [] }),
  )
}

export function setTitle(number: number, title: string): Promise<boolean> {
  return writeIssue(
    number,
    (issue) => ({ ...issue, title }),
    (fresh) => (fresh.title === title ? null : { title }),
  )
}

export function setMilestone(number: number, milestone: boolean): Promise<boolean> {
  return writeIssue(
    number,
    (issue) => ({ ...issue, milestone }),
    (fresh) => {
      const names = labelNames(fresh)
      if (names.includes(MILESTONE_LABEL) === milestone) return null
      return { labels: milestone ? [...names, MILESTONE_LABEL] : names.filter((name) => name !== MILESTONE_LABEL) }
    },
  )
}

/** Правка тела: функция применяется и к копии на экране, и к свежему телу с сервера. */
export function changeBody(number: number, change: (body: IssueBody) => IssueBody): Promise<boolean> {
  return writeIssue(
    number,
    (issue) => ({ ...issue, body: change(issue.body) }),
    (fresh) => {
      const next = serializeBody(change(withItemIds(parseBody(fresh.body))))
      return next === (fresh.body ?? '') ? null : { body: next }
    },
  )
}

/** Связь «связана с» записывается в обе задачи. */
export async function linkIssues(a: number, b: number, linked: boolean): Promise<boolean> {
  const results = await Promise.all([
    changeBody(a, linked ? addLink(b) : removeLink(b)),
    changeBody(b, linked ? addLink(a) : removeLink(a)),
  ])
  return results.every(Boolean)
}

export interface NewIssueInput {
  title: string
  description: string
  status: StatusKey
  assignee: string | null
  milestone: boolean
}

export async function createIssue(input: NewIssueInput): Promise<number | null> {
  const current = requireSession()
  const labels = [STATUSES[input.status].label, input.milestone ? MILESTONE_LABEL : null].filter(
    (label): label is string => Boolean(label),
  )
  try {
    const created = await current.client.createIssue({
      title: input.title.trim(),
      body: serializeBody({ ...emptyBody(), description: input.description }),
      labels,
      assignees: input.assignee ? [input.assignee] : [],
    })
    acceptServer(created)
    return created.number
  } catch (error) {
    notify(`Задача не создана: ${errorText(error)}`, 'error')
    return null
  }
}

// Комментарии

export type CommentsState =
  | { status: 'loading' }
  | { status: 'ready'; items: Comment[] }
  | { status: 'error'; error: string }

export const commentsByIssue = signal<ReadonlyMap<number, CommentsState>>(new Map())

function setComments(number: number, state: CommentsState): void {
  const next = new Map(commentsByIssue.value)
  next.set(number, state)
  commentsByIssue.value = next
}

export async function loadComments(number: number): Promise<void> {
  const current = requireSession()
  if (!commentsByIssue.value.has(number)) setComments(number, { status: 'loading' })
  try {
    const list = await current.client.comments(number)
    setComments(number, { status: 'ready', items: list.map(toComment) })
  } catch (error) {
    setComments(number, { status: 'error', error: errorText(error) })
  }
}

async function afterCommentChange(number: number): Promise<void> {
  const current = requireSession()
  try {
    acceptServer(await current.client.issue(number))
  } catch {
    // счётчик обновится при следующей синхронизации
  }
}

export async function addComment(number: number, text: string): Promise<boolean> {
  const current = requireSession()
  try {
    const created = await current.client.createComment(number, text)
    const state = commentsByIssue.value.get(number)
    const items = state?.status === 'ready' ? state.items : []
    setComments(number, { status: 'ready', items: [...items, toComment(created)] })
    void afterCommentChange(number)
    return true
  } catch (error) {
    notify(`Комментарий не отправлен: ${errorText(error)}`, 'error')
    return false
  }
}

export async function editComment(number: number, comment: Comment, text: string): Promise<boolean> {
  const current = requireSession()
  // У перенесённого комментария сохраняем подпись и маркер происхождения.
  const { tail } = parseCommentBody(comment.raw.body)
  try {
    const updated = await current.client.updateComment(comment.id, `${text.trimEnd()}${tail}`)
    const state = commentsByIssue.value.get(number)
    if (state?.status === 'ready') {
      setComments(number, {
        status: 'ready',
        items: state.items.map((item) => (item.id === comment.id ? toComment(updated) : item)),
      })
    }
    return true
  } catch (error) {
    notify(`Комментарий не сохранён: ${errorText(error)}`, 'error')
    return false
  }
}

export async function deleteComment(number: number, comment: Comment): Promise<boolean> {
  const current = requireSession()
  try {
    await current.client.deleteComment(comment.id)
    const state = commentsByIssue.value.get(number)
    if (state?.status === 'ready') {
      setComments(number, { status: 'ready', items: state.items.filter((item) => item.id !== comment.id) })
    }
    void afterCommentChange(number)
    return true
  } catch (error) {
    notify(`Комментарий не удалён: ${errorText(error)}`, 'error')
    return false
  }
}

// История и уведомления

/** Уведомления — изменения за последние две недели. Старые видны в истории задачи. */
export const FEED_DAYS = 14
const DAY_MS = 86_400_000
/** Запас при повторной выборке: изменения той же секунды не теряются. */
const FEED_OVERLAP_MS = 60_000

export type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; history: IssueHistory }
  | { status: 'error'; error: string }

/** История по задачам: и для вкладки «История», и для ленты уведомлений. */
export const activityByIssue = signal<ReadonlyMap<number, HistoryState>>(new Map())
export const feed = signal<{ status: 'idle' | 'loading' | 'ready' | 'error'; error?: string }>({ status: 'idle' })
/** До какого момента (мс) уведомления просмотрены. */
export const seenAt = signal(0)

/** Изменения за FEED_DAYS по всем задачам, новые первыми. */
export const feedEntries = computed<ActivityEntry[]>(() => {
  const since = Date.now() - FEED_DAYS * DAY_MS
  const list: ActivityEntry[] = []
  for (const state of activityByIssue.value.values()) {
    if (state.status !== 'ready') continue
    for (const entry of state.history.entries) {
      if (!entry.historyOnly && Date.parse(entry.at) >= since) list.push(entry)
    }
  }
  return list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
})

/** Изменения других людей, которых вы ещё не видели. */
export const unreadCount = computed(() => {
  const login = session.value?.viewer.login
  return feedEntries.value.filter((entry) => entry.actor.login !== login && Date.parse(entry.at) > seenAt.value).length
})

function seenKey(login: string): string {
  return `tracker.seen.${login}`
}

function restoreSeen(login: string): void {
  const stored = Number(localStorage.getItem(seenKey(login)))
  if (stored) seenAt.value = stored
  // Первый вход: всё, что было до него, — не новость.
  else saveSeen(login, Date.now())
}

function saveSeen(login: string, at: number): void {
  seenAt.value = at
  localStorage.setItem(seenKey(login), String(at))
}

/** Отметить просмотренными все уведомления, которые уже пришли. */
export function markFeedSeen(): void {
  const login = session.value?.viewer.login
  if (!login) return
  const latest = Math.max(0, ...feedEntries.value.filter((entry) => entry.actor.login !== login).map((entry) => Date.parse(entry.at)))
  if (latest > seenAt.value) saveSeen(login, latest)
}

// Отметка из другой вкладки: счётчик гаснет везде.
window.addEventListener('storage', (event) => {
  const login = session.value?.viewer.login
  if (login && event.key === seenKey(login) && event.newValue) seenAt.value = Number(event.newValue) || seenAt.value
})

function putHistories(list: GqlIssueActivity[]): void {
  if (!list.length) return
  const next = new Map(activityByIssue.value)
  for (const activity of list) next.set(activity.number, { status: 'ready', history: buildHistory(activity) })
  activityByIssue.value = next
}

function setHistory(number: number, state: HistoryState): void {
  const next = new Map(activityByIssue.value)
  next.set(number, state)
  activityByIssue.value = next
}

/** До какого `updated_at` (мс) лента знает изменения задач. */
let feedWatermark = 0
let feedSync: Promise<void> | null = null

/**
 * Подтягивает историю задач, изменённых после прошлой синхронизации. Что
 * изменилось, видно по `updated_at` из обычного обновления списка, поэтому
 * без изменений запросов к GraphQL нет.
 */
function syncFeed(current: Session): Promise<void> {
  feedSync ??= (async () => {
    const first = feed.value.status !== 'ready'
    let latest = 0
    for (const gh of serverIssues.values()) latest = Math.max(latest, Date.parse(gh.updated_at))
    if (!first && latest <= feedWatermark) return
    const since = first ? Date.now() - FEED_DAYS * DAY_MS : feedWatermark - FEED_OVERLAP_MS
    if (first) feed.value = { status: 'loading' }
    try {
      const list = await current.client.recentActivity(new Date(since).toISOString())
      if (session.value !== current) return
      putHistories(list)
      // Метка — по ответу GraphQL: если он отстал от списка задач, следующее обновление спросит снова.
      feedWatermark = Math.max(feedWatermark, first ? since : 0, ...list.map((activity) => Date.parse(activity.updatedAt)))
      feed.value = { status: 'ready' }
    } catch (error) {
      // Уже показанная лента остаётся; повторим при следующем обновлении.
      if (first && session.value === current) feed.value = { status: 'error', error: errorText(error) }
    }
  })().finally(() => {
    feedSync = null
  })
  return feedSync
}

const historyLoads = new Map<number, Promise<void>>()

/** История для вкладки задачи. Загрузки одной задачи идут по очереди, свежую не перезапрашиваем. */
export function loadHistory(number: number): Promise<void> {
  const task = () => fetchHistory(number, true)
  const run = (historyLoads.get(number) ?? Promise.resolve()).then(task, task)
  historyLoads.set(number, run)
  void run.then(() => {
    if (historyLoads.get(number) === run) historyLoads.delete(number)
  })
  return run
}

/** Не бросает исключений: ошибка остаётся в состоянии истории. */
async function fetchHistory(number: number, retry: boolean): Promise<void> {
  const current = session.value
  if (!current) return
  // Лента, возможно, как раз везёт эту задачу.
  await feedSync
  const expected = Date.parse(serverIssues.get(number)?.updated_at ?? '') || 0
  const state = activityByIssue.value.get(number)
  if (state?.status === 'ready' && Date.parse(state.history.updatedAt) >= expected) return
  if (state?.status !== 'ready') setHistory(number, { status: 'loading' })
  try {
    const activity = await current.client.issueActivity(number)
    if (session.value !== current) return
    if (!activity) throw new Error('Задача не найдена')
    setHistory(number, { status: 'ready', history: buildHistory(activity) })
    // GraphQL может на секунды отставать от REST: тогда спросим ещё раз.
    if (retry && Date.parse(activity.updatedAt) < expected) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      if (session.value === current) await fetchHistory(number, false)
    }
  } catch (error) {
    if (session.value === current && state?.status !== 'ready') setHistory(number, { status: 'error', error: errorText(error) })
  }
}

// Файлы

export interface Uploaded {
  name: string
  url: string
  markdown: string
}

export async function uploadFile(file: File, issueNumber: number | null): Promise<Uploaded | null> {
  const current = requireSession()
  if (file.size > MAX_UPLOAD_BYTES) {
    notify(`«${file.name}» больше 10 МБ — такой файл не загрузить.`, 'error')
    return null
  }
  const name = safeFileName(file.name || 'image.png')
  const folder = issueNumber ? `${KEY_PREFIX}-${issueNumber}` : 'new'
  const path = `attachments/${folder}/${Date.now().toString(36)}-${name}`
  try {
    const where = issueNumber ? ` к ${KEY_PREFIX}-${issueNumber}` : ''
    await current.client.putFile(path, await fileToBase64(file), `Вложение${where}: ${name}`)
    const url = repoFileUrl(current.repo, current.branch, path)
    return { name, url, markdown: `${isImageName(name) ? '!' : ''}[${name}](${url})` }
  } catch (error) {
    notify(`Файл не загрузился: ${errorText(error)}`, 'error')
    return null
  }
}
