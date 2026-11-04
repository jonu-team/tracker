import type {
  GhComment,
  GhContentFile,
  GhIssue,
  GhLabel,
  GhRepo,
  GhUser,
  IssuePatch,
  NewIssue,
} from '../domain/github-types.ts'

/** Клиент GitHub REST API. Работает в браузере и в Node (скрипт переноса). */

export interface RepoRef {
  owner: string
  name: string
}

export function parseRepoRef(text: string): RepoRef | null {
  const match = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(text)
  return match ? { owner: match[1]!, name: match[2]! } : null
}

export function repoRefString(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`
}

export class GitHubError extends Error {
  readonly status: number
  readonly rateLimited: boolean

  constructor(status: number, message: string, rateLimited = false) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.rateLimited = rateLimited
  }
}

export interface GitHubClientOptions {
  token: string
  repo: RepoRef
  fetch?: typeof fetch
  baseUrl?: string
  /**
   * Браузер кэширует ответы GitHub до 60 секунд. `no-cache` заставляет
   * переспрашивать сервер по ETag: свежие данные, а ответ 304 не тратит лимит.
   * В Node параметр `cache` не поддерживается, там он выключен.
   */
  revalidate?: boolean
}

type Query = Record<string, string | number | undefined>

interface RequestOptions {
  body?: unknown
  query?: Query
  accept?: string
}

const API_VERSION = '2022-11-28'

export class GitHubClient {
  readonly repo: RepoRef
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #baseUrl: string
  readonly #revalidate: boolean

  constructor(options: GitHubClientOptions) {
    this.repo = options.repo
    this.#token = options.token
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#baseUrl = options.baseUrl ?? 'https://api.github.com'
    this.#revalidate = options.revalidate ?? false
  }

  get #repoPath(): string {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}`
  }

  async #send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.#baseUrl + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/vnd.github+json',
      Authorization: `Bearer ${this.#token}`,
      'X-GitHub-Api-Version': API_VERSION,
    }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    if (this.#revalidate && method === 'GET') init.cache = 'no-cache'

    let response: Response
    try {
      response = await this.#fetch(url.toString(), init)
    } catch {
      throw new GitHubError(0, 'Нет связи с GitHub. Проверьте интернет и попробуйте ещё раз.')
    }
    if (!response.ok) throw await toError(response)
    return response
  }

  async #json<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    const response = await this.#send(method, path, options)
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  async #paginate<T>(path: string, query: Query = {}): Promise<T[]> {
    const items: T[] = []
    let page = 1
    for (;;) {
      const response = await this.#send('GET', path, { query: { per_page: 100, ...query, page } })
      items.push(...((await response.json()) as T[]))
      if (!/rel="next"/.test(response.headers.get('link') ?? '')) return items
      page += 1
    }
  }

  // Пользователь и репозиторий

  viewer(): Promise<GhUser> {
    return this.#json('GET', '/user')
  }

  user(login: string): Promise<GhUser> {
    return this.#json('GET', `/users/${encodeURIComponent(login)}`)
  }

  repository(): Promise<GhRepo> {
    return this.#json('GET', this.#repoPath)
  }

  assignees(): Promise<GhUser[]> {
    return this.#paginate(`${this.#repoPath}/assignees`)
  }

  async isAssignable(login: string): Promise<boolean> {
    try {
      await this.#send('GET', `${this.#repoPath}/assignees/${encodeURIComponent(login)}`)
      return true
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false
      throw error
    }
  }

  // Задачи

  /** Все issue репозитория (открытые и закрытые), без pull request. */
  async issues(): Promise<GhIssue[]> {
    const all = await this.#paginate<GhIssue>(`${this.#repoPath}/issues`, {
      state: 'all',
      sort: 'created',
      direction: 'asc',
    })
    return all.filter((issue) => !issue.pull_request)
  }

  issue(number: number): Promise<GhIssue> {
    return this.#json('GET', `${this.#repoPath}/issues/${number}`)
  }

  createIssue(issue: NewIssue): Promise<GhIssue> {
    return this.#json('POST', `${this.#repoPath}/issues`, { body: issue })
  }

  updateIssue(number: number, patch: IssuePatch): Promise<GhIssue> {
    return this.#json('PATCH', `${this.#repoPath}/issues/${number}`, { body: patch })
  }

  /** Есть ли в репозитории pull request: они занимают номера наравне с issue. */
  async hasPullRequests(): Promise<boolean> {
    const pulls = await this.#json<unknown[]>('GET', `${this.#repoPath}/pulls`, { query: { state: 'all', per_page: 1 } })
    return pulls.length > 0
  }

  // Комментарии

  comments(number: number): Promise<GhComment[]> {
    return this.#paginate(`${this.#repoPath}/issues/${number}/comments`)
  }

  createComment(number: number, body: string): Promise<GhComment> {
    return this.#json('POST', `${this.#repoPath}/issues/${number}/comments`, { body: { body } })
  }

  updateComment(id: number, body: string): Promise<GhComment> {
    return this.#json('PATCH', `${this.#repoPath}/issues/comments/${id}`, { body: { body } })
  }

  async deleteComment(id: number): Promise<void> {
    await this.#send('DELETE', `${this.#repoPath}/issues/comments/${id}`)
  }

  // Метки

  labels(): Promise<GhLabel[]> {
    return this.#paginate(`${this.#repoPath}/labels`)
  }

  createLabel(label: { name: string; color: string; description?: string }): Promise<GhLabel> {
    return this.#json('POST', `${this.#repoPath}/labels`, { body: label })
  }

  // Файлы (картинки и вложения)

  /** Содержимое файла из репозитория: картинки показываем через API, а не по прямой ссылке. */
  async fileBlob(path: string, ref?: string): Promise<Blob> {
    const response = await this.#send('GET', `${this.#repoPath}/contents/${encodePath(path)}`, {
      accept: 'application/vnd.github.raw+json',
      query: { ref },
    })
    return response.blob()
  }

  async fileInfo(path: string): Promise<GhContentFile | null> {
    try {
      return await this.#json<GhContentFile>('GET', `${this.#repoPath}/contents/${encodePath(path)}`)
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null
      throw error
    }
  }

  async putFile(path: string, base64: string, message: string, sha?: string): Promise<GhContentFile> {
    const result = await this.#json<{ content: GhContentFile }>(
      'PUT',
      `${this.#repoPath}/contents/${encodePath(path)}`,
      { body: { message, content: base64, ...(sha ? { sha } : {}) } },
    )
    return result.content
  }
}

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

async function toError(response: Response): Promise<GitHubError> {
  let detail = ''
  try {
    const data = (await response.json()) as { message?: string; errors?: { message?: string; code?: string }[] }
    detail = [data.message, ...(data.errors ?? []).map((e) => e.message ?? e.code)].filter(Boolean).join('; ')
  } catch {
    // тело не JSON — обойдёмся статусом
  }
  const remaining = response.headers.get('x-ratelimit-remaining')
  const rateLimited =
    response.status === 429 || (response.status === 403 && (remaining === '0' || /rate limit/i.test(detail)))
  if (rateLimited) {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const when = reset ? ` Лимит обновится в ${new Date(reset * 1000).toLocaleTimeString('ru-RU')}.` : ''
    return new GitHubError(response.status, `GitHub временно ограничил запросы.${when}`, true)
  }
  const messages: Record<number, string> = {
    401: 'Токен не подошёл: истёк, отозван или вставлен с ошибкой.',
    403: 'Нет прав на это действие. Проверьте права токена: Issues и Contents — чтение и запись.',
    404: 'Не найдено. Возможно, у токена нет доступа к репозиторию с задачами.',
    409: 'Конфликт изменений. Обновите страницу и повторите.',
    422: 'GitHub не принял данные',
  }
  const base = messages[response.status] ?? `GitHub ответил ошибкой ${response.status}`
  return new GitHubError(response.status, response.status === 422 && detail ? `${base}: ${detail}` : base)
}
