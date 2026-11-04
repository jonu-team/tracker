/** Настройки сборки. Это не секреты: название приложения и репозиторий с задачами. */

export const APP_TITLE = import.meta.env.VITE_APP_TITLE || 'Трекер'

/** Префикс ключей: задача #26 показывается как DEV-26. */
export const KEY_PREFIX = import.meta.env.VITE_KEY_PREFIX || 'DEV'

/** Репозиторий с задачами `owner/name` по умолчанию; можно сменить на экране входа. */
export const DEFAULT_TASKS_REPO = import.meta.env.VITE_TASKS_REPO || ''

const TOKEN_KEY = 'tracker.token'
const REPO_KEY = 'tracker.repo'

export function storedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function forgetToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function storedRepo(): string {
  return localStorage.getItem(REPO_KEY) || DEFAULT_TASKS_REPO
}

export function storeRepo(repo: string): void {
  if (repo === DEFAULT_TASKS_REPO) localStorage.removeItem(REPO_KEY)
  else localStorage.setItem(REPO_KEY, repo)
}
