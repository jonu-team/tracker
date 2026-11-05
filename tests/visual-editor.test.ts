// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createVisualEditor, type VisualEditor } from '../src/ui/visual-editor.ts'

async function open(markdown: string, onChange: (markdown: string) => void = () => {}): Promise<VisualEditor> {
  const root = document.createElement('div')
  document.body.append(root)
  return createVisualEditor({ root, markdown, onChange, upload: async () => null, resolveImage: async () => null })
}

async function roundtrip(markdown: string): Promise<string> {
  const editor = await open(markdown)
  const out = editor.getMarkdown()
  editor.destroy()
  return out
}

describe('визуальный редактор: markdown туда и обратно', () => {
  it.each([
    ['перевод строки внутри абзаца', 'строка один\nстрока два\n\nновый абзац'],
    ['списки', '- первый\n- второй\n  - вложенный\n\n1. раз\n2. два'],
    ['отметки', '- [ ] открыто\n- [x] сделано'],
    ['оформление', '**жирный**, *курсив*, ~~зачёркнутый~~, `код` и [ссылка](https://example.com)'],
    ['картинка из репозитория', 'Экран: ![image.png](https://github.com/o/r/blob/main/attachments/DEV-1/1-image.png?raw=true)'],
    ['блок кода', '```\nPOST /x  →  200\n```\n\nтекст'],
    ['цитата', '> цитата\n> вторая строка\n\nответ'],
    ['заголовок и ссылки на задачи', '## Заголовок\n\nтекст #12 и DEV-5'],
    ['экранированный дефис после переноса строки', 'первая\n\\- вторая [ссылка](https://x.y) хвост'],
    ['«пустая строка» из Трекера', 'текст\n\n&nbsp;\n\nещё'],
  ])('%s', async (_, markdown) => {
    expect(await roundtrip(markdown)).toBe(markdown)
  })

  it('сообщает о правках пользователя, но не о подстановке текста снаружи', async () => {
    const changes: string[] = []
    const editor = await open('текст', (markdown) => changes.push(markdown))
    editor.setMarkdown('новый текст')
    expect(changes).toEqual([])
    editor.run('taskList')
    expect(changes.at(-1)).toBe('- [ ] новый текст')
    editor.run('taskList')
    expect(changes.at(-1)).toBe('новый текст')
    editor.destroy()
  })

  it('сохраняет отметки и ссылки, проставленные с панели', async () => {
    const changes: string[] = []
    const editor = await open('пункт', (markdown) => changes.push(markdown))
    editor.focus('end')
    editor.run('taskList')
    expect(changes.at(-1)).toBe('- [ ] пункт')
    editor.run('bulletList')
    expect(changes.at(-1)).toBe('- пункт')
    editor.setLink('https://example.com')
    // ссылка, у которой текст совпадает с адресом, пишется короткой формой
    expect(editor.getMarkdown()).toBe('- пункт<https://example.com>')
    editor.destroy()
  })

  it('после цитаты в конце оставляет место для ответа вне цитаты', async () => {
    const changes: string[] = []
    const editor = await open('> цитата', (markdown) => changes.push(markdown))
    editor.focus('end')
    expect(editor.getMarkdown()).toBe('> цитата')
    editor.destroy()
  })
})
