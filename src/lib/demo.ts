import type { GhComment, GhIssue, GhLabel, GhUser, IssuePatch, NewIssue } from '../domain/github-types.ts'
import type { RepoRef } from './github.ts'

/**
 * Поддельный GitHub REST API в памяти: ровно те методы, которыми пользуется
 * трекер и скрипт переноса. Работает в двух местах:
 * - демо-режим сайта (`npm run demo`) — данные из `.demo/`, весь остальной код
 *   (клиент API, разбор задач, экраны) работает как с настоящим GitHub;
 * - тесты переноса в Node.
 * Изменения живут до перезагрузки страницы. В продакшн-сборку модуль не попадает.
 */

export interface FakeFixture {
  repo: { owner: string; name: string; default_branch: string }
  viewer: GhUser
  /** Кого можно назначать исполнителем. */
  users: GhUser[]
  labels: GhLabel[]
  issues: (GhIssue & { _comments: GhComment[] })[]
  /** Файлы, которые уже лежат в репозитории. */
  files: string[]
}

export interface FakeOptions {
  latencyMs?: number
  /** Содержимое файла из фикстуры (в браузере — с dev-сервера). */
  loadFile?: (path: string) => Promise<Response>
  /** git blob sha для ответа «информация о файле»; без него — заглушка. */
  blobSha?: (bytes: Uint8Array) => string
}

export interface FakeGitHub {
  fetch: typeof fetch
  repo: RepoRef
  /** Состояние для проверок в тестах. */
  state: { issues: Map<number, GhIssue>; comments: Map<number, GhComment[]>; uploads: Map<string, Uint8Array<ArrayBuffer>>; labels: GhLabel[] }
}

export function createFakeGitHub(fixture: FakeFixture, options: FakeOptions = {}): FakeGitHub {
  const issues = new Map<number, GhIssue>()
  const comments = new Map<number, GhComment[]>()
  for (const { _comments, ...issue } of fixture.issues) {
    issues.set(issue.number, issue)
    comments.set(issue.number, _comments)
  }
  const uploads = new Map<string, Uint8Array<ArrayBuffer>>()
  const labels = [...fixture.labels]
  const repoPath = `/repos/${fixture.repo.owner}/${fixture.repo.name}`
  let nextCommentId = 1_000_000

  const now = () => new Date().toISOString()
  const user = (login: string) => fixture.users.find((candidate) => candidate.login === login)
  const assignable = (logins: string[] | undefined) =>
    (logins ?? []).map(user).filter((found): found is GhUser => Boolean(found))

  function patchIssue(issue: GhIssue, patch: IssuePatch): GhIssue {
    const next: GhIssue = { ...issue, updated_at: now() }
    if (patch.title !== undefined) next.title = patch.title
    if (patch.body !== undefined) next.body = patch.body
    if (patch.labels) next.labels = patch.labels.map((name) => ({ name }))
    if (patch.assignees) next.assignees = assignable(patch.assignees)
    if (patch.state && patch.state !== issue.state) {
      next.state = patch.state
      next.closed_at = patch.state === 'closed' ? now() : null
      next.state_reason = patch.state === 'closed' ? (patch.state_reason ?? 'completed') : 'reopened'
    }
    issues.set(issue.number, next)
    return next
  }

  async function route(method: string, url: URL, body: unknown, accept: string): Promise<Response> {
    const path = decodeURIComponent(url.pathname)
    if (method === 'GET' && path === '/user') return json(fixture.viewer)
    if (method === 'GET' && path.startsWith('/users/')) {
      const found = user(path.slice('/users/'.length))
      return found ? json(found) : notFound()
    }
    if (!path.startsWith(repoPath)) return notFound()
    const rest = path.slice(repoPath.length)

    if (method === 'GET' && rest === '') {
      return json({
        id: 1,
        name: fixture.repo.name,
        full_name: `${fixture.repo.owner}/${fixture.repo.name}`,
        private: true,
        default_branch: fixture.repo.default_branch,
        has_issues: true,
        permissions: { admin: false, push: true, pull: true },
      })
    }
    if (method === 'GET' && rest === '/assignees') return json(fixture.users)
    if (method === 'GET' && rest.startsWith('/assignees/')) {
      return user(rest.slice('/assignees/'.length)) ? new Response(null, { status: 204 }) : notFound()
    }
    if (method === 'GET' && rest === '/pulls') return json([])
    if (rest === '/labels') {
      if (method === 'GET') return json(labels)
      if (method === 'POST') {
        labels.push(body as GhLabel)
        return json(body, 201)
      }
    }

    if (rest === '/issues') {
      if (method === 'GET') return json([...issues.values()].sort((a, b) => a.number - b.number))
      if (method === 'POST') {
        const input = body as NewIssue
        const number = Math.max(0, ...issues.keys()) + 1
        const created: GhIssue = {
          number,
          title: input.title,
          body: input.body ?? null,
          state: 'open',
          state_reason: null,
          labels: (input.labels ?? []).map((name) => ({ name })),
          assignees: assignable(input.assignees),
          user: fixture.viewer,
          comments: 0,
          created_at: now(),
          updated_at: now(),
          closed_at: null,
          html_url: `https://github.com/${fixture.repo.owner}/${fixture.repo.name}/issues/${number}`,
        }
        issues.set(number, created)
        comments.set(number, [])
        return json(created, 201)
      }
    }

    const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest)
    if (issueMatch) {
      const number = Number(issueMatch[1])
      const issue = issues.get(number)
      if (!issue) return notFound()
      if (!issueMatch[2]) {
        if (method === 'GET') return json(issue)
        if (method === 'PATCH') return json(patchIssue(issue, body as IssuePatch))
      } else {
        const list = comments.get(number) ?? []
        if (method === 'GET') return json(list)
        if (method === 'POST') {
          const id = nextCommentId++
          const comment: GhComment = {
            id,
            body: (body as { body: string }).body,
            user: fixture.viewer,
            created_at: now(),
            updated_at: now(),
            html_url: `${issue.html_url}#issuecomment-${id}`,
          }
          comments.set(number, [...list, comment])
          issues.set(number, { ...issue, comments: list.length + 1, updated_at: now() })
          return json(comment, 201)
        }
      }
    }

    const commentMatch = /^\/issues\/comments\/(\d+)$/.exec(rest)
    if (commentMatch) {
      const id = Number(commentMatch[1])
      for (const [number, list] of comments) {
        const index = list.findIndex((comment) => comment.id === id)
        if (index < 0) continue
        if (method === 'PATCH') {
          const updated = { ...list[index]!, body: (body as { body: string }).body, updated_at: now() }
          comments.set(number, list.with(index, updated))
          return json(updated)
        }
        if (method === 'DELETE') {
          comments.set(number, list.filter((comment) => comment.id !== id))
          const issue = issues.get(number)!
          issues.set(number, { ...issue, comments: Math.max(0, issue.comments - 1) })
          return new Response(null, { status: 204 })
        }
      }
      return notFound()
    }

    if (rest.startsWith('/contents/')) {
      const filePath = rest.slice('/contents/'.length)
      if (method === 'PUT') {
        const bytes = Uint8Array.from(atob((body as { content: string }).content), (char) => char.charCodeAt(0))
        uploads.set(filePath, bytes)
        return json({ content: fileInfo(filePath, bytes) }, 201)
      }
      if (method === 'GET') {
        const uploaded = uploads.get(filePath)
        if (accept.includes('raw')) {
          if (uploaded) return new Response(new Blob([uploaded]))
          if (fixture.files.includes(filePath) && options.loadFile) return options.loadFile(filePath)
          return notFound()
        }
        return uploaded ? json(fileInfo(filePath, uploaded)) : notFound()
      }
    }
    return notFound()
  }

  function fileInfo(path: string, bytes: Uint8Array) {
    return { type: 'file', name: path.split('/').pop(), path, sha: options.blobSha?.(bytes) ?? 'fake', size: bytes.length }
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    const accept = new Headers(init?.headers).get('Accept') ?? ''
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs))
    return route(method, url, body, accept)
  }

  return {
    fetch: fakeFetch,
    repo: { owner: fixture.repo.owner, name: fixture.repo.name },
    state: { issues, comments, uploads, labels },
  }
}

/** Демо-режим сайта: фикстура и файлы с dev-сервера (`/__demo/`). */
export async function createDemoBackend(): Promise<{ fetch: typeof fetch; repo: RepoRef; token: string }> {
  const response = await fetch('/__demo/fixture.json')
  if (!response.ok) throw new Error('Нет демо-данных: выполните `npm run demo:fixture`.')
  const fake = createFakeGitHub((await response.json()) as FakeFixture, {
    latencyMs: 150,
    loadFile: (path) => fetch(`/__demo/files/${path.split('/').map(encodeURIComponent).join('/')}`),
  })
  return { fetch: fake.fetch, repo: fake.repo, token: 'demo' }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function notFound(): Response {
  return json({ message: 'Not Found' }, 404)
}
