import TurndownService from 'turndown'

/**
 * Выделенный фрагмент описания или комментария → markdown для цитаты.
 * Работает по отрисованному HTML, поэтому сохраняет оформление: жирный,
 * ссылки, код, списки. Подгружается при первой цитате.
 */

const service = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  // в задачах GitHub перевод строки — уже разрыв строки
  br: '',
})

service.addRule('strike', {
  filter: ['del', 's'],
  replacement: (content) => `~~${content}~~`,
})

service.addRule('taskCheckbox', {
  filter: (node) => node.nodeName === 'INPUT' && node.getAttribute('type') === 'checkbox',
  replacement: (_, node) => ((node as HTMLInputElement).hasAttribute('checked') ? '[x] ' : '[ ] '),
})

// Картинки из репозитория показаны через blob:, в цитату идёт исходный адрес.
service.addRule('repoImage', {
  filter: 'img',
  replacement: (_, node) => {
    const element = node as HTMLElement
    const src = element.getAttribute('data-src') ?? element.getAttribute('data-external-src') ?? ''
    const alt = (element.getAttribute('alt') ?? '').replace(/[[\]]/g, '')
    return src ? `![${alt}](${src})` : alt
  },
})

// Ссылки на задачи трекера уже показаны ключом DEV-12 — достаточно текста.
service.addRule('issueRef', {
  filter: (node) => node.nodeName === 'A' && (node.getAttribute('href') ?? '').startsWith('#/'),
  replacement: (content) => content,
})

export function selectionToMarkdown(range: Range): string {
  const container = document.createElement('div')
  container.append(range.cloneContents())
  const start = range.commonAncestorContainer
  const element = start instanceof Element ? start : start.parentElement
  // внутри блока кода фрагмент приходит без <pre> — оформляем блоком сами
  if (element?.closest('pre')) {
    return `\`\`\`\n${(container.textContent ?? '').replace(/\n+$/, '')}\n\`\`\``
  }
  return service.turndown(container).trim()
}
