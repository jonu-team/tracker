import { useState } from 'preact/hooks'
import { APP_TITLE, DEFAULT_TASKS_REPO, storedRepo } from '../config.ts'
import { parseRepoRef, type RepoRef } from '../lib/github.ts'
import { errorText, signIn } from '../store.ts'
import { Icon } from './icons.tsx'

/** Ссылка на форму fine-grained токена с заполненными полями (параметры описаны в docs.github.com). */
function tokenFormUrl(repo: RepoRef): string {
  const params = new URLSearchParams({
    name: `${APP_TITLE}: ${repo.name}`.slice(0, 40),
    description: `Вход на сайт трекера: задачи в ${repo.owner}/${repo.name}`,
    target_name: repo.owner,
    expires_in: '366',
    issues: 'write',
    contents: 'write',
  })
  return `https://github.com/settings/personal-access-tokens/new?${params}`
}

export function Login() {
  const [token, setToken] = useState('')
  const [repoText, setRepoText] = useState(storedRepo())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const repo = parseRepoRef(repoText)

  const submit = async (event: Event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await signIn(token, repoText)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="login">
      <form class="login__card" onSubmit={submit}>
        <img class="login__logo" src="./favicon.svg" alt="" width={40} height={40} />
        <h1 class="login__title">{APP_TITLE}</h1>
        <p class="login__lead">
          Задачи хранятся в GitHub Issues {repo ? <b>{repo.owner}/{repo.name}</b> : 'репозитория'}. Войдите своим токеном
          GitHub.
        </p>

        <label class="label-text" for="token">
          Токен GitHub
        </label>
        <input
          id="token"
          class="input"
          type="password"
          autoComplete="off"
          spellcheck={false}
          placeholder="github_pat_…"
          value={token}
          onInput={(event) => setToken(event.currentTarget.value)}
          required
        />

        {DEFAULT_TASKS_REPO ? (
          <details class="login__repo">
            <summary>Другой репозиторий</summary>
            <input class="input" value={repoText} spellcheck={false} onInput={(event) => setRepoText(event.currentTarget.value)} />
          </details>
        ) : (
          <>
            <label class="label-text" for="repo">
              Репозиторий с задачами
            </label>
            <input id="repo" class="input" placeholder="owner/name" value={repoText} spellcheck={false} onInput={(event) => setRepoText(event.currentTarget.value)} required />
          </>
        )}

        {error && <div class="alert alert--error">{error}</div>}

        <button type="submit" class="btn btn--action btn--l btn--wide" disabled={!token.trim() || !repo || busy}>
          {busy ? 'Проверяю токен…' : 'Войти'}
        </button>

        <details class="howto" open={!token}>
          <summary>Как выпустить токен — 2 минуты</summary>
          <ol>
            <li>
              Откройте форму токена в GitHub:{' '}
              {repo ? (
                <a href={tokenFormUrl(repo)} target="_blank" rel="noopener noreferrer">
                  заполненная форма
                  <Icon name="external" size={12} />
                </a>
              ) : (
                'Settings → Developer settings → Fine-grained tokens → Generate new token'
              )}
              . Срок, владелец и права в ней уже выставлены.
            </li>
            <li>
              <b>Resource owner</b> — организация <b>{repo?.owner ?? '…'}</b>.
            </li>
            <li>
              <b>Repository access</b> → <b>Only select repositories</b> → <b>{repo?.name ?? '…'}</b>.
            </li>
            <li>
              <b>Permissions → Repositories</b>: <b>Issues</b> и <b>Contents</b> — Read and write. Metadata (Read-only)
              добавится сам.
            </li>
            <li>
              <b>Generate token</b>, скопируйте токен (начинается с <code>github_pat_</code>) и вставьте выше.
            </li>
          </ol>
          <p>
            Если вы участник организации, а не её владелец, токен сначала одобрит владелец: Settings организации → Personal
            access tokens → Pending requests.
          </p>
        </details>

        <p class="login__note">
          Токен хранится только в этом браузере и уходит только в api.github.com. «Выйти» удаляет его отсюда.
        </p>
      </form>
    </div>
  )
}
