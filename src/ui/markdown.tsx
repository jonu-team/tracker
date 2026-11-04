import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { KEY_PREFIX } from '../config.ts'
import { loadRepoFile } from '../lib/files.ts'
import type { GitHubClient } from '../lib/github.ts'
import { renderInlineMarkdown, renderMarkdown } from '../lib/markdown.ts'
import { session, uploadFile } from '../store.ts'
import { Icon } from './icons.tsx'

export const lightbox = signal<{ src: string; alt: string } | null>(null)

/** Картинки из репозитория грузим через API, сторонние превращаем в ссылки. */
function hydrateImages(root: HTMLElement, client: GitHubClient): () => void {
  let cancelled = false
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-repo-path]')) {
    img.classList.add('is-loading')
    loadRepoFile(client, { path: img.dataset.repoPath!, ref: img.dataset.repoRef! }).then(
      (url) => {
        if (cancelled) return
        img.src = url
        img.classList.remove('is-loading')
      },
      () => {
        if (cancelled) return
        const note = document.createElement('span')
        note.className = 'md-missing'
        note.textContent = `Картинка не загрузилась: ${img.alt || img.dataset.repoPath}`
        img.replaceWith(note)
      },
    )
  }
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-external-src]')) {
    const link = document.createElement('a')
    link.href = img.dataset.externalSrc!
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = `Картинка: ${img.alt || img.dataset.externalSrc}`
    img.replaceWith(link)
  }
  return () => {
    cancelled = true
  }
}

function openImage(event: MouseEvent): void {
  const target = event.target
  if (target instanceof HTMLImageElement && target.src) {
    event.preventDefault()
    lightbox.value = { src: target.src, alt: target.alt }
  }
}

export function Markdown({ text, inline = false, class: className = '' }: { text: string; inline?: boolean; class?: string }) {
  const current = session.value!
  const html = useMemo(() => {
    const ctx = { prefix: KEY_PREFIX, repo: current.repo }
    return inline ? renderInlineMarkdown(text, ctx) : renderMarkdown(text, ctx)
  }, [text, inline, current.repo])
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => (root.current ? hydrateImages(root.current, current.client) : undefined), [html, current.client])
  const Tag = inline ? 'span' : 'div'
  return <Tag ref={root} class={`${inline ? 'md-inline' : 'md'} ${className}`} dangerouslySetInnerHTML={{ __html: html }} onClick={openImage} />
}

export function Lightbox() {
  const image = lightbox.value
  useEffect(() => {
    if (!image) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') lightbox.value = null
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [image])
  if (!image) return null
  return (
    <div class="lightbox" role="dialog" aria-label={image.alt || 'Картинка'} onClick={() => (lightbox.value = null)}>
      <img src={image.src} alt={image.alt} />
      <button type="button" class="lightbox__close btn btn--icon" aria-label="Закрыть">
        <Icon name="x" size={20} />
      </button>
    </div>
  )
}

interface EditorProps {
  value: string
  onInput: (value: string) => void
  /** К какой задаче складывать картинки; null — задача ещё не создана. */
  issueNumber: number | null
  placeholder?: string
  autoFocus?: boolean
  minRows?: number
  onSubmit?: () => void
  onCancel?: () => void
}

/** Поле markdown с предпросмотром; картинки — вставкой из буфера, перетаскиванием или кнопкой. */
export function MarkdownEditor({ value, onInput, issueNumber, placeholder, autoFocus, minRows = 4, onSubmit, onCancel }: EditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [uploading, setUploading] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const latest = useRef(value)
  latest.current = value

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, Math.max(240, window.innerHeight * 0.6))}px`
  }, [value, tab])

  useEffect(() => {
    if (autoFocus) area.current?.focus()
  }, [autoFocus])

  async function insertFiles(files: File[]) {
    for (const file of files) {
      const placeholderText = `![Загрузка: ${file.name || 'картинка'}…]()`
      const el = area.current
      const start = el?.selectionStart ?? latest.current.length
      const end = el?.selectionEnd ?? start
      const before = latest.current.slice(0, start)
      const gap = before && !before.endsWith('\n') ? '\n' : ''
      onInput(`${before}${gap}${placeholderText}\n${latest.current.slice(end)}`)
      setUploading((count) => count + 1)
      const uploaded = await uploadFile(file, issueNumber)
      setUploading((count) => count - 1)
      onInput(latest.current.replace(placeholderText, uploaded ? uploaded.markdown : ''))
    }
  }

  return (
    <div class="editor">
      <div class="editor__bar">
        <div class="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'write'} class={tab === 'write' ? 'is-active' : ''} onClick={() => setTab('write')}>
            Текст
          </button>
          <button type="button" role="tab" aria-selected={tab === 'preview'} class={tab === 'preview' ? 'is-active' : ''} onClick={() => setTab('preview')}>
            Просмотр
          </button>
        </div>
        <span class="editor__hint">Markdown · картинку можно вставить из буфера</span>
        <button type="button" class="btn btn--flat btn--s" onClick={() => fileInput.current?.click()} title="Прикрепить картинку или файл">
          <Icon name="image" />
          <span class="hide-mobile">Картинка</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const input = event.currentTarget
            const files = [...(input.files ?? [])]
            input.value = ''
            if (files.length) void insertFiles(files)
          }}
        />
      </div>
      {tab === 'write' ? (
        <textarea
          ref={area}
          class="editor__area"
          rows={minRows}
          value={value}
          placeholder={placeholder}
          onInput={(event) => onInput(event.currentTarget.value)}
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])]
            if (!files.length) return
            event.preventDefault()
            void insertFiles(files)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const files = [...(event.dataTransfer?.files ?? [])]
            if (!files.length) return
            event.preventDefault()
            void insertFiles(files)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmit) {
              event.preventDefault()
              onSubmit()
            } else if (event.key === 'Escape' && onCancel) {
              event.preventDefault()
              onCancel()
            }
          }}
        />
      ) : (
        <div class="editor__preview">{value.trim() ? <Markdown text={value} /> : <span class="muted">Пусто</span>}</div>
      )}
      {uploading > 0 && <div class="editor__status">Загружаю файлы: {uploading}…</div>}
    </div>
  )
}
