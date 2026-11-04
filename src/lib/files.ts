import { encodePath, type GitHubClient, type RepoRef } from './github.ts'

/**
 * Картинки и вложения лежат файлами в приватном репозитории с задачами.
 * Прямая ссылка на github.com без входа в GitHub не откроется, поэтому
 * файл забираем через API с токеном и показываем как blob:.
 */

export interface RepoFile {
  path: string
  ref: string
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Путь к файлу репозитория по ссылке из markdown, если ссылка на этот репозиторий. */
export function repoFileFromUrl(url: string, repo: RepoRef): RepoFile | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const owner = repo.owner.toLowerCase()
  const name = repo.name.toLowerCase()
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parsed.hostname === 'github.com') {
    const [o, r, kind, ref, ...rest] = parts
    if (o?.toLowerCase() === owner && r?.toLowerCase() === name && (kind === 'blob' || kind === 'raw') && ref && rest.length) {
      return { ref, path: rest.join('/') }
    }
  }
  if (parsed.hostname === 'raw.githubusercontent.com') {
    const [o, r, ref, ...rest] = parts
    if (o?.toLowerCase() === owner && r?.toLowerCase() === name && ref && rest.length) return { ref, path: rest.join('/') }
  }
  return null
}

export function repoFileUrl(repo: RepoRef, branch: string, path: string): string {
  return `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${encodePath(path)}?raw=true`
}

const objectUrls = new Map<string, Promise<string>>()

export function loadRepoFile(client: GitHubClient, file: RepoFile): Promise<string> {
  const key = `${file.ref}:${file.path}`
  let url = objectUrls.get(key)
  if (!url) {
    url = client.fileBlob(file.path, file.ref).then((blob) => URL.createObjectURL(blob))
    url.catch(() => objectUrls.delete(key))
    objectUrls.set(key, url)
  }
  return url
}

export function forgetRepoFiles(): void {
  for (const url of objectUrls.values()) url.then(URL.revokeObjectURL, () => undefined)
  objectUrls.clear()
}

/** Безопасное имя файла: латиница, кириллица, цифры, точка, дефис. */
export function safeFileName(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = (dot > 0 ? name.slice(0, dot) : name).normalize('NFC')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  const cleanBase = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'file'
  return ext ? `${cleanBase}.${ext}` : cleanBase
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
