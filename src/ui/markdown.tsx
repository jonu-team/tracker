import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { KEY_PREFIX } from '../config.ts'
import { loadRepoFile, repoFileFromUrl } from '../lib/files.ts'
import type { GitHubClient } from '../lib/github.ts'
import { renderInlineMarkdown, renderMarkdown } from '../lib/markdown.ts'
import { notify, session, uploadFile } from '../store.ts'
import { Menu, MenuItem, Spinner } from './common.tsx'
import { Icon, type IconName } from './icons.tsx'
import { editorMode, setEditorMode } from './prefs.ts'
import type { FormatCommand, FormatState, VisualEditor } from './visual-editor.ts'

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

/** Адрес для показа картинки в редакторе: файлы приватного репозитория — через API. */
async function resolveImage(src: string): Promise<string | null> {
  if (/^(data:image\/|blob:)/.test(src)) return src
  const current = session.value
  const file = current && repoFileFromUrl(src, current.repo)
  if (!current || !file) return null
  try {
    return await loadRepoFile(current.client, file)
  } catch {
    return null
  }
}

function openImage(event: MouseEvent): void {
  const target = event.target
  if (target instanceof HTMLImageElement && target.src) {
    event.preventDefault()
    lightbox.value = { src: target.src, alt: target.alt }
  }
}

export function Markdown({
  text,
  inline = false,
  quotable = false,
  class: className = '',
}: {
  text: string
  inline?: boolean
  /** Из текста можно цитировать в комментарий. */
  quotable?: boolean
  class?: string
}) {
  const current = session.value!
  const html = useMemo(() => {
    const ctx = { prefix: KEY_PREFIX, repo: current.repo }
    return inline ? renderInlineMarkdown(text, ctx) : renderMarkdown(text, ctx)
  }, [text, inline, current.repo])
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => (root.current ? hydrateImages(root.current, current.client) : undefined), [html, current.client])
  const Tag = inline ? 'span' : 'div'
  return (
    <Tag
      ref={root}
      class={`${inline ? 'md-inline' : 'md'} ${className}`}
      data-quotable={quotable ? '' : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={openImage}
    />
  )
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
  /** Растёт — поле получает фокус, курсор в конец (например, после добавленной цитаты). */
  focusRequest?: number
}

const MARK_TOOLS: { command: FormatCommand; icon: IconName; title: string; active: (state: FormatState) => boolean }[] = [
  { command: 'strong', icon: 'bold', title: 'Жирный (⌘B)', active: (state) => state.strong },
  { command: 'emphasis', icon: 'italic', title: 'Курсив (⌘I)', active: (state) => state.emphasis },
  { command: 'strike', icon: 'strike', title: 'Зачёркнутый', active: (state) => state.strike },
  { command: 'code', icon: 'code', title: 'Код в строке', active: (state) => state.code },
]

const BLOCK_TOOLS: { command: FormatCommand; icon: IconName; title: string; active: (state: FormatState) => boolean }[] = [
  { command: 'bulletList', icon: 'list', title: 'Маркированный список', active: (state) => state.bulletList },
  { command: 'orderedList', icon: 'orderedList', title: 'Нумерованный список', active: (state) => state.orderedList },
  { command: 'taskList', icon: 'checklist', title: 'Список с отметками', active: (state) => state.taskList },
  { command: 'blockquote', icon: 'quote', title: 'Цитата', active: (state) => state.blockquote },
  { command: 'codeBlock', icon: 'codeBlock', title: 'Блок кода', active: (state) => state.block === 'codeBlock' },
]

const BLOCK_TYPES: { command: FormatCommand; title: string }[] = [
  { command: 'paragraph', title: 'Обычный текст' },
  { command: 'h1', title: 'Заголовок 1' },
  { command: 'h2', title: 'Заголовок 2' },
  { command: 'h3', title: 'Заголовок 3' },
]

/**
 * Редактор текста. Два режима — визуальный и markdown — переключаются
 * тогглом; выбор запоминается. Картинки — вставкой из буфера,
 * перетаскиванием или кнопкой: файлы ложатся в репозиторий с задачами.
 */
export function MarkdownEditor(props: EditorProps) {
  const mode = editorMode.value
  const [uploading, setUploading] = useState(0)
  const [format, setFormat] = useState<FormatState | null>(null)
  const [linkDraft, setLinkDraft] = useState<string | null>(null)
  const visual = useRef<VisualEditor | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode !== 'visual') {
      setFormat(null)
      setLinkDraft(null)
    }
  }, [mode])

  async function attach(files: File[]) {
    setUploading((count) => count + files.length)
    try {
      if (mode === 'visual' && visual.current) await visual.current.insertFiles(files)
      else await insertMarkdownFiles(files)
    } finally {
      setUploading((count) => count - files.length)
    }
  }

  // в режиме markdown файл становится строкой ![имя](адрес) там, где курсор
  const textarea = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(props.value)
  latest.current = props.value
  async function insertMarkdownFiles(files: File[]) {
    for (const file of files) {
      const placeholderText = `![Загрузка: ${file.name || 'картинка'}…]()`
      const el = textarea.current
      const start = el?.selectionStart ?? latest.current.length
      const end = el?.selectionEnd ?? start
      const before = latest.current.slice(0, start)
      const gap = before && !before.endsWith('\n') ? '\n' : ''
      props.onInput(`${before}${gap}${placeholderText}\n${latest.current.slice(end)}`)
      const uploaded = await uploadFile(file, props.issueNumber)
      props.onInput(latest.current.replace(placeholderText, uploaded ? uploaded.markdown : ''))
    }
  }

  return (
    <div class={`text-editor text-editor--${mode}`}>
      <div class="text-editor__bar">
        <div class="segmented" role="tablist" aria-label="Режим редактора">
          <button type="button" role="tab" aria-selected={mode === 'visual'} class={mode === 'visual' ? 'is-active' : ''} onClick={() => setEditorMode('visual')}>
            Визуально
          </button>
          <button type="button" role="tab" aria-selected={mode === 'markdown'} class={mode === 'markdown' ? 'is-active' : ''} onClick={() => setEditorMode('markdown')}>
            Markdown
          </button>
        </div>
        {mode === 'visual' ? (
          <div class="toolbar" role="toolbar" aria-label="Оформление">
            {MARK_TOOLS.map((tool) => (
              <ToolButton key={tool.command} icon={tool.icon} title={tool.title} active={Boolean(format && tool.active(format))} disabled={!format} onClick={() => visual.current?.run(tool.command)} />
            ))}
            <ToolButton icon="link" title="Ссылка" active={format?.link != null} disabled={!format} onClick={() => setLinkDraft(format?.link ?? '')} />
            <span class="toolbar__sep" />
            <Menu
              triggerClass={`tool${format?.block.startsWith('h') ? ' is-active' : ''}`}
              title="Заголовок"
              disabled={!format}
              label={<Icon name="heading" />}
            >
              {(close) =>
                BLOCK_TYPES.map((type) => (
                  <MenuItem key={type.command} selected={format?.block === type.command} onSelect={() => (close(), visual.current?.run(type.command))}>
                    {type.title}
                  </MenuItem>
                ))
              }
            </Menu>
            {BLOCK_TOOLS.map((tool) => (
              <ToolButton key={tool.command} icon={tool.icon} title={tool.title} active={Boolean(format && tool.active(format))} disabled={!format} onClick={() => visual.current?.run(tool.command)} />
            ))}
          </div>
        ) : (
          <span class="text-editor__hint">Картинку можно вставить из буфера</span>
        )}
        <button
          type="button"
          class="btn btn--flat btn--s text-editor__attach"
          title="Прикрепить картинку или файл"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => fileInput.current?.click()}
        >
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
            if (files.length) void attach(files)
          }}
        />
      </div>
      {linkDraft !== null && (
        <LinkForm
          initial={linkDraft}
          canRemove={Boolean(format?.link)}
          onApply={(href) => {
            setLinkDraft(null)
            visual.current?.setLink(href)
          }}
          onCancel={() => setLinkDraft(null)}
        />
      )}
      {mode === 'visual' ? (
        <VisualSurface
          {...props}
          onReady={(editor) => (visual.current = editor)}
          onFormat={setFormat}
          onFail={() => {
            notify('Визуальный редактор не загрузился — открыт markdown.', 'error')
            setEditorMode('markdown')
          }}
        />
      ) : (
        <MarkdownArea {...props} textarea={textarea} onFiles={(files) => void attach(files)} />
      )}
      {uploading > 0 && <div class="text-editor__status">Загружаю файлы: {uploading}…</div>}
    </div>
  )
}

function ToolButton({ icon, title, active, disabled, onClick }: { icon: IconName; title: string; active: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      class={`tool${active ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      // фокус остаётся в тексте, иначе пропадёт выделение
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  )
}

function LinkForm({ initial, canRemove, onApply, onCancel }: { initial: string; canRemove: boolean; onApply: (href: string | null) => void; onCancel: () => void }) {
  const [href, setHref] = useState(initial)
  const apply = () => {
    const value = href.trim()
    if (!value) return onApply(null)
    // «example.com» без схемы — внешний адрес
    onApply(/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(value) ? value : `https://${value}`)
  }
  return (
    <div class="text-editor__link">
      <input
        class="input"
        type="url"
        inputMode="url"
        placeholder="https://…"
        value={href}
        ref={(el) => el?.focus()}
        onInput={(event) => setHref(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.preventDefault(), apply())
          if (event.key === 'Escape') (event.preventDefault(), onCancel())
        }}
      />
      <button type="button" class="btn btn--outlined btn--s" onClick={apply}>
        Применить
      </button>
      {canRemove && (
        <button type="button" class="btn btn--flat btn--s" onClick={() => onApply(null)}>
          Убрать ссылку
        </button>
      )}
      <button type="button" class="btn btn--flat btn--s" onClick={onCancel}>
        Отмена
      </button>
    </div>
  )
}

interface SurfaceProps extends EditorProps {
  onReady: (editor: VisualEditor | null) => void
  onFormat: (state: FormatState) => void
  onFail: () => void
}

/** Визуальный режим: Milkdown подгружается отдельным куском при первом показе. */
function VisualSurface({ value, onInput, issueNumber, placeholder, autoFocus, onSubmit, onCancel, focusRequest, onReady, onFormat, onFail }: SurfaceProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<VisualEditor | null>(null)
  /** Последний markdown, который знает редактор: чтобы не применять обратно его же правку. */
  const known = useRef(value)
  const live = useRef({ value, onInput, issueNumber, onFormat })
  live.current = { value, onInput, issueNumber, onFormat }
  const initialFocus = useRef(focusRequest)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let disposed = false
    let created: VisualEditor | null = null
    import('./visual-editor.ts')
      .then(({ createVisualEditor }) =>
        createVisualEditor({
          root: host.current!,
          markdown: live.current.value,
          placeholder,
          onChange: (markdown) => {
            known.current = markdown
            live.current.onInput(markdown)
          },
          onState: (state) => live.current.onFormat(state),
          upload: async (file) => {
            const uploaded = await uploadFile(file, live.current.issueNumber)
            return uploaded && { name: uploaded.name, url: uploaded.url }
          },
          resolveImage,
        }),
      )
      .then((instance) => {
        if (disposed) return instance.destroy()
        created = instance
        editor.current = instance
        known.current = live.current.value
        onReady(instance)
        setReady(true)
        if (autoFocus) instance.focus('end')
      })
      .catch(() => {
        if (!disposed) onFail()
      })
    return () => {
      disposed = true
      created?.destroy()
      editor.current = null
      onReady(null)
    }
  }, [])

  // текст поменяли снаружи (например, добавили цитату) — показываем его
  useEffect(() => {
    const instance = editor.current
    if (!instance || value === known.current) return
    known.current = value
    instance.setMarkdown(value)
  }, [value])

  useEffect(() => {
    if (focusRequest !== initialFocus.current) editor.current?.focus('end')
  }, [focusRequest])

  return (
    <div
      class="visual-editor"
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmit) {
          event.preventDefault()
          event.stopPropagation()
          onSubmit()
        } else if (event.key === 'Escape' && onCancel) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div ref={host} />
      {!ready && (
        <div class="visual-editor__loading">
          <Spinner />
        </div>
      )}
    </div>
  )
}

interface AreaProps extends EditorProps {
  textarea: { current: HTMLTextAreaElement | null }
  onFiles: (files: File[]) => void
}

function MarkdownArea({ value, onInput, placeholder, autoFocus, minRows = 4, onSubmit, onCancel, focusRequest, textarea, onFiles }: AreaProps) {
  const initialFocus = useRef(focusRequest)

  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, Math.max(240, window.innerHeight * 0.6))}px`
  }, [value])

  const focusEnd = () => {
    const el = textarea.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
  useEffect(() => {
    if (autoFocus) focusEnd()
  }, [])
  useEffect(() => {
    if (focusRequest !== initialFocus.current) focusEnd()
  }, [focusRequest])

  return (
    <textarea
      ref={textarea}
      class="text-editor__area"
      rows={minRows}
      value={value}
      placeholder={placeholder}
      onInput={(event) => onInput(event.currentTarget.value)}
      onPaste={(event) => {
        const files = [...(event.clipboardData?.files ?? [])]
        if (!files.length) return
        event.preventDefault()
        onFiles(files)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (!files.length) return
        event.preventDefault()
        onFiles(files)
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
  )
}
