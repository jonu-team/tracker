import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  serializerCtx,
  type CmdKey,
} from '@milkdown/kit/core'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history } from '@milkdown/kit/plugin/history'
import { upload, uploadConfig } from '@milkdown/kit/plugin/upload'
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  commonmark,
  createCodeBlockCommand,
  emphasisSchema,
  hardbreakSchema,
  headingSchema,
  imageSchema,
  inlineCodeSchema,
  linkSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  remarkPreserveEmptyLinePlugin,
  strongSchema,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark'
import { gfm, strikethroughSchema, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { lift } from '@milkdown/kit/prose/commands'
import type { MarkType, Node as ProseNode, NodeType, ResolvedPos } from '@milkdown/kit/prose/model'
import { liftListItem } from '@milkdown/kit/prose/schema-list'
import { Plugin, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, type EditorView } from '@milkdown/kit/prose/view'
import { $prose, $view, callCommand, replaceAll } from '@milkdown/kit/utils'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import { isImageName } from '../domain/body.ts'

/**
 * Визуальный редактор markdown на Milkdown (ProseMirror + remark с GFM).
 * Источник правды — markdown-строка: редактор её разбирает и после каждой
 * правки собирает обратно. Подгружается отдельным куском при первом
 * редактировании.
 *
 * Отличия от стандартной сборки Milkdown — под GitHub issues:
 * - одиночный перевод строки в GitHub — разрыв строки, а не пробел: такие
 *   переводы показываем как <br> и сохраняем как перевод строки;
 * - пустые абзацы не превращаем в `<br />` в тексте: markdown их не хранит.
 */

export type FormatCommand =
  | 'strong'
  | 'emphasis'
  | 'strike'
  | 'code'
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'

export interface FormatState {
  strong: boolean
  emphasis: boolean
  strike: boolean
  code: boolean
  link: string | null
  block: 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'codeBlock' | 'other'
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  blockquote: boolean
}

export interface VisualEditorOptions {
  root: HTMLElement
  markdown: string
  placeholder?: string
  onChange: (markdown: string) => void
  onState?: (state: FormatState) => void
  /** Загружает файл в репозиторий; null — не вышло (ошибку показывает вызывающий). */
  upload: (file: File) => Promise<{ name: string; url: string } | null>
  /** Адрес для показа картинки: файлы приватного репозитория — через API как blob:. */
  resolveImage: (src: string) => Promise<string | null>
}

export interface VisualEditor {
  run(command: FormatCommand): void
  setLink(href: string | null): void
  insertFiles(files: File[]): Promise<void>
  setMarkdown(markdown: string): void
  getMarkdown(): string
  focus(at?: 'end'): void
  destroy(): void
}

interface Types {
  strong: MarkType
  emphasis: MarkType
  strike: MarkType
  code: MarkType
  link: MarkType
  paragraph: NodeType
  heading: NodeType
  codeBlock: NodeType
  blockquote: NodeType
  bulletList: NodeType
  orderedList: NodeType
  listItem: NodeType
  image: NodeType
}

/** Одиночный перевод строки (мягкий разрыв) показываем строкой, а не пробелом. */
const softBreakAsLine = hardbreakSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    parseDOM: [{ tag: 'br[data-soft]', getAttrs: () => ({ isInline: true }) }, ...(base.parseDOM ?? [])],
    toDOM: (node: ProseNode) => (node.attrs.isInline ? ['br', { 'data-soft': '' }] : ['br']),
  }
})

const withoutEmptyLineHtml = new Set<unknown>([remarkPreserveEmptyLinePlugin.plugin, remarkPreserveEmptyLinePlugin.options])

interface TextState {
  safe(value: string, config: Record<string, unknown>): string
}

/**
 * Текст в markdown. Обработчик Milkdown не экранирует фрагмент, который
 * кончается пробелом, и строка «\\- пункт [ссылка]» после переноса строки
 * становилась пунктом списка. Здесь экранируется всё, кроме хвостовых пробелов.
 * Абзац из одних неразрывных пробелов («пустая строка» из Трекера) пишем как
 * `&nbsp;`: голый символ при разборе markdown отбрасывается.
 */
function escapedText(node: { value: string }, _parent: unknown, state: TextState, info: Record<string, unknown>): string {
  const { value } = node
  if (/^[\s\u00a0]*$/.test(value) && value.includes('\u00a0')) return value.replace(/\u00a0/g, '&nbsp;')
  const trailing = /\s*$/.exec(value)![0]
  const head = value.slice(0, value.length - trailing.length)
  if (!head) return trailing
  return state.safe(head, { ...info, after: trailing.charAt(0) || info.after, encode: [] }) + trailing
}

export function cleanMarkdown(markdown: string): string {
  return markdown.replace(/\s+$/, '')
}

export async function createVisualEditor(options: VisualEditorOptions): Promise<VisualEditor> {
  /** Пока применяем внешний markdown, правки не считаются пользовательскими. */
  let silent = false
  /** Типы узлов и меток схемы; заполняются сразу после создания редактора. */
  let types = {} as Types

  const imageView = $view(imageSchema.node, () => (initial) => {
    const img = document.createElement('img')
    let shown = ''
    const render = (node: ProseNode) => {
      img.alt = node.attrs.alt ?? ''
      img.title = node.attrs.title ?? ''
      const src: string = node.attrs.src ?? ''
      if (src === shown) return
      shown = src
      img.removeAttribute('src')
      img.classList.remove('is-broken')
      img.classList.add('is-loading')
      void options.resolveImage(src).then((url) => {
        if (src !== shown) return
        img.classList.remove('is-loading')
        if (url) img.src = url
        else img.classList.add('is-broken')
      })
    }
    render(initial)
    return {
      dom: img,
      update: (node) => {
        if (node.type !== initial.type) return false
        render(node)
        return true
      },
      ignoreMutation: () => true,
    }
  })

  const changes = $prose((ctx) => {
    const sync = (view: EditorView) => {
      view.dom.classList.toggle('is-empty', isEmptyDoc(view.state.doc))
      options.onState?.(formatState(view.state, types))
    }
    return new Plugin({
      view: (view) => {
        sync(view)
        return {
          update: (current, previous) => {
            sync(current)
            if (silent || current.state.doc.eq(previous.doc)) return
            options.onChange(cleanMarkdown(ctx.get(serializerCtx)(current.state.doc)))
          },
        }
      },
    })
  })

  /** Клик по квадратику у пункта-отметки переключает его. */
  const taskToggle = $prose(
    () =>
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown: (view, event) => {
              const target = event.target
              if (!(target instanceof HTMLElement) || target.tagName !== 'LI' || target.dataset.itemType !== 'task') return false
              if (event.clientX - target.getBoundingClientRect().left > 24) return false
              const $pos = view.state.doc.resolve(view.posAtDOM(target, 0))
              for (let depth = $pos.depth; depth > 0; depth -= 1) {
                const node = $pos.node(depth)
                if (node.type !== types.listItem) continue
                view.dispatch(view.state.tr.setNodeMarkup($pos.before(depth), undefined, { ...node.attrs, checked: !node.attrs.checked }))
                event.preventDefault()
                return true
              }
              return false
            },
          },
        },
      }),
  )

  /** Enter в пункте с отметкой даёт новый пункт тоже с отметкой, как в GitHub. */
  const taskContinuation = $prose(
    () =>
      new Plugin({
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const item = closestListItem(state.selection.$from, types.listItem)
          if (!item || item.node.attrs.checked != null || item.node.textContent) return null
          const $item = state.doc.resolve(item.pos)
          const index = $item.index()
          if (index === 0 || $item.parent.child(index - 1).attrs.checked == null) return null
          return state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: false })
        },
      }),
  )

  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.root)
      ctx.set(defaultValueCtx, options.markdown)
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { class: 'md visual-editor__content', 'data-placeholder': options.placeholder ?? '' },
      }))
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        handlers: { ...prev.handlers, text: escapedText as unknown as NonNullable<typeof prev.handlers>['text'] },
        bullet: '-' as const,
        emphasis: '*' as const,
        strong: '*' as const,
        fence: '`' as const,
        rule: '-' as const,
        listItemIndent: 'one' as const,
      }))
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        enableHtmlFileUploader: false,
        uploader: async (files, schema) => {
          const nodes: ProseNode[] = []
          for (const file of Array.from(files)) {
            const uploaded = await options.upload(file)
            if (uploaded) nodes.push(fileNode(schema.nodes.image!, schema.marks.link!, schema, uploaded))
          }
          return nodes
        },
        uploadWidgetFactory: (pos, spec) =>
          Decoration.widget(
            pos,
            () => {
              const note = document.createElement('span')
              note.className = 'visual-editor__uploading'
              note.textContent = 'Загрузка…'
              return note
            },
            spec,
          ),
      }))
    })
    .use(commonmark.filter((plugin) => !withoutEmptyLineHtml.has(plugin)))
    .use(gfm)
    .use(softBreakAsLine)
    .use(history)
    .use(clipboard)
    .use(upload)
    .use(imageView)
    .use(taskToggle)
    .use(taskContinuation)
    .use(changes)

  await editor.create()
  types = editor.action((ctx) => ({
    strong: strongSchema.type(ctx),
    emphasis: emphasisSchema.type(ctx),
    strike: strikethroughSchema.type(ctx),
    code: inlineCodeSchema.type(ctx),
    link: linkSchema.type(ctx),
    paragraph: paragraphSchema.type(ctx),
    heading: headingSchema.type(ctx),
    codeBlock: codeBlockSchema.type(ctx),
    blockquote: blockquoteSchema.type(ctx),
    bulletList: bulletListSchema.type(ctx),
    orderedList: orderedListSchema.type(ctx),
    listItem: listItemSchema.type(ctx),
    image: imageSchema.type(ctx),
  }))

  const view = (): EditorView => editor.action((ctx) => ctx.get(editorViewCtx))
  const refreshState = () => options.onState?.(formatState(view().state, types))
  refreshState()

  const call = <T,>(key: CmdKey<T>, payload?: T): void => {
    editor.action(callCommand(key, payload))
  }

  function run(command: FormatCommand): void {
    const current = formatState(view().state, types)
    switch (command) {
      case 'strong':
        call(toggleStrongCommand.key)
        break
      case 'emphasis':
        call(toggleEmphasisCommand.key)
        break
      case 'strike':
        call(toggleStrikethroughCommand.key)
        break
      case 'code':
        call(toggleInlineCodeCommand.key)
        break
      case 'paragraph':
        call(turnIntoTextCommand.key)
        break
      case 'h1':
      case 'h2':
      case 'h3':
        if (current.block === command) call(turnIntoTextCommand.key)
        else call(wrapInHeadingCommand.key, Number(command.slice(1)))
        break
      case 'bulletList':
        toggleList(types.bulletList, current.bulletList, false)
        break
      case 'orderedList':
        toggleList(types.orderedList, current.orderedList, false)
        break
      case 'taskList':
        toggleList(types.bulletList, current.taskList, true)
        break
      case 'blockquote':
        if (current.blockquote) lift(view().state, view().dispatch)
        else call(wrapInBlockquoteCommand.key)
        break
      case 'codeBlock':
        if (current.block === 'codeBlock') call(turnIntoTextCommand.key)
        else call(createCodeBlockCommand.key)
        break
    }
    view().focus()
  }

  /** Список нужного вида: снять, сменить вид или завернуть абзацы в список. */
  function toggleList(listType: NodeType, active: boolean, task: boolean): void {
    const editorView = view()
    const item = closestListItem(editorView.state.selection.$from, types.listItem)
    if (active && item) {
      // повторное нажатие снимает список целиком, у отметок — вместе с признаком отметки
      if (task) setTaskState(item.pos, null)
      liftListItem(types.listItem)(view().state, view().dispatch)
      return
    }
    if (item) {
      // уже в списке: отметки бывают и в нумерованном списке, вид меняем только для обычных пунктов
      const $item = editorView.state.doc.resolve(item.pos)
      if (!task && $item.parent.type !== listType) editorView.dispatch(editorView.state.tr.setNodeMarkup($item.before(), listType))
      setTaskState(item.pos, task ? false : null)
      return
    }
    call(listType === types.orderedList ? wrapInOrderedListCommand.key : wrapInBulletListCommand.key)
    if (task) {
      const created = closestListItem(view().state.selection.$from, types.listItem)
      if (created) setTaskState(created.pos, false)
    }
  }

  function setTaskState(pos: number, checked: boolean | null): void {
    const editorView = view()
    const node = editorView.state.doc.nodeAt(pos)
    if (!node || node.attrs.checked === checked) return
    editorView.dispatch(editorView.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }))
  }

  function setLink(href: string | null): void {
    const editorView = view()
    const { state } = editorView
    const { from, to, empty, $from } = state.selection
    let tr = state.tr
    const range = empty ? markRange($from, types.link) : { from, to }
    if (!href) {
      if (range) tr = tr.removeMark(range.from, range.to, types.link)
    } else if (range) {
      tr = tr.removeMark(range.from, range.to, types.link).addMark(range.from, range.to, types.link.create({ href }))
    } else {
      tr = tr.insertText(href, from).addMark(from, from + href.length, types.link.create({ href }))
    }
    editorView.dispatch(tr)
    editorView.focus()
  }

  async function insertFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const uploaded = await options.upload(file)
      if (!uploaded) continue
      const editorView = view()
      const { schema } = editorView.state
      const node = fileNode(types.image, types.link, schema, uploaded)
      editorView.dispatch(editorView.state.tr.replaceSelectionWith(node, false).scrollIntoView())
    }
    view().focus()
  }

  function setMarkdown(markdown: string): void {
    silent = true
    try {
      editor.action(replaceAll(markdown))
    } finally {
      silent = false
    }
    refreshState()
  }

  function getMarkdown(): string {
    return cleanMarkdown(editor.action((ctx) => ctx.get(serializerCtx)(view().state.doc)))
  }

  /** Курсор в конец. Если документ кончается цитатой или списком — добавляем абзац после, чтобы писать вне их. */
  function focus(at?: 'end'): void {
    const editorView = view()
    if (at === 'end') {
      let tr = editorView.state.tr
      const last = tr.doc.lastChild
      if (last && last.type !== types.paragraph) tr = tr.insert(tr.doc.content.size, types.paragraph.create())
      tr = tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView()
      editorView.dispatch(tr)
    }
    editorView.focus()
  }

  return {
    run,
    setLink,
    insertFiles,
    setMarkdown,
    getMarkdown,
    focus,
    destroy: () => void editor.destroy(),
  }
}

function fileNode(
  image: NodeType,
  link: MarkType,
  schema: EditorState['schema'],
  file: { name: string; url: string },
): ProseNode {
  return isImageName(file.name)
    ? image.create({ src: file.url, alt: file.name })
    : schema.text(file.name, [link.create({ href: file.url })])
}

function isEmptyDoc(doc: ProseNode): boolean {
  return doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0
}

function closestListItem($pos: ResolvedPos, listItem: NodeType): { pos: number; node: ProseNode } | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.type === listItem) return { pos: $pos.before(depth), node }
  }
  return null
}

/** Границы ссылки вокруг курсора. */
function markRange($pos: ResolvedPos, type: MarkType): { from: number; to: number } | null {
  const { parent } = $pos
  const offsets: number[] = []
  parent.forEach((_, offset) => offsets.push(offset))
  const has = (index: number) => index >= 0 && index < parent.childCount && Boolean(type.isInSet(parent.child(index).marks))
  let index = $pos.index()
  if (!has(index) && has(index - 1)) index -= 1
  if (!has(index)) return null
  let first = index
  let last = index
  while (has(first - 1)) first -= 1
  while (has(last + 1)) last += 1
  const start = $pos.start()
  return { from: start + offsets[first]!, to: start + offsets[last]! + parent.child(last).nodeSize }
}

export function formatState(state: EditorState, types: Types): FormatState {
  const { from, to, empty, $from } = state.selection
  const hasMark = (type: MarkType | undefined) => {
    if (!type) return false
    return empty ? Boolean(type.isInSet(state.storedMarks ?? $from.marks())) : state.doc.rangeHasMark(from, to, type)
  }
  let list: 'bullet' | 'ordered' | null = null
  let task = false
  let quote = false
  let itemSeen = false
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type === types.listItem && !itemSeen) {
      itemSeen = true
      task = node.attrs.checked != null
    }
    if (!list && node.type === types.bulletList) list = 'bullet'
    if (!list && node.type === types.orderedList) list = 'ordered'
    if (node.type === types.blockquote) quote = true
  }
  const parent = $from.parent
  const block: FormatState['block'] =
    parent.type === types.heading
      ? (`h${Math.min(6, Number(parent.attrs.level) || 1)}` as FormatState['block'])
      : parent.type === types.codeBlock
        ? 'codeBlock'
        : parent.type === types.paragraph
          ? 'paragraph'
          : 'other'
  const linkMark = types.link && (empty ? types.link.isInSet($from.marks()) : null)
  return {
    strong: hasMark(types.strong),
    emphasis: hasMark(types.emphasis),
    strike: hasMark(types.strike),
    code: hasMark(types.code),
    link: linkMark ? String(linkMark.attrs.href ?? '') : hasMark(types.link) ? '' : null,
    block,
    bulletList: list === 'bullet' && !task,
    orderedList: list === 'ordered' && !task,
    taskList: task,
    blockquote: quote,
  }
}
