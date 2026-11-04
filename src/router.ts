import { signal } from '@preact/signals'
import { KEY_PREFIX } from './config.ts'
import { parseKey } from './domain/issue.ts'

/** Маршруты в hash: GitHub Pages не умеет отдавать index.html на любой путь. */
export type Route =
  | { name: 'board'; query: URLSearchParams }
  | { name: 'list'; query: URLSearchParams }
  | { name: 'issue'; number: number }
  | { name: 'new' }
  | { name: 'notFound' }

function parse(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?')
  const query = new URLSearchParams(search)
  const segment = path.replace(/^\/+|\/+$/g, '')
  if (segment === '' || segment === 'board') return { name: 'board', query }
  if (segment === 'list') return { name: 'list', query }
  if (segment === 'new') return { name: 'new' }
  const number = parseKey(KEY_PREFIX, decodeURIComponent(segment))
  return number ? { name: 'issue', number } : { name: 'notFound' }
}

export const route = signal<Route>(parse(location.hash))

window.addEventListener('hashchange', () => {
  route.value = parse(location.hash)
})

export function navigate(hash: string, { replace = false } = {}): void {
  const target = hash.startsWith('#') ? hash : `#${hash}`
  if (replace) {
    history.replaceState(null, '', target)
    route.value = parse(target)
  } else {
    location.hash = target
  }
}

export function issueHref(number: number): string {
  return `#/${KEY_PREFIX}-${number}`
}

export function withQuery(base: string, query: URLSearchParams): string {
  const search = query.toString()
  return search ? `${base}?${search}` : base
}
