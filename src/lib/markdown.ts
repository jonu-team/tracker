import DOMPurify from 'dompurify'
import { Marked, type TokenizerAndRendererExtension } from 'marked'
import { repoFileFromUrl } from './files.ts'
import type { RepoRef } from './github.ts'

/**
 * Markdown как в GitHub issues: GFM, перевод строки — разрыв строки.
 * Результат всегда проходит через DOMPurify. Ссылки `DEV-12`, `#12` и
 * адреса issue этого репозитория ведут на страницу задачи внутри трекера
 * и показываются ключом `DEV-12`.
 */

export interface RenderContext {
  prefix: string
  repo: RepoRef
}

function issueRefs(prefix: string): TokenizerAndRendererExtension {
  const start = new RegExp(String.raw`(?<![\w/&#-])(?:${prefix}-\d+|#\d+)\b`)
  const exact = new RegExp(String.raw`^(?:${prefix}-(\d+)|#(\d+))\b`)
  return {
    name: 'issueRef',
    level: 'inline',
    start: (src) => src.search(start),
    tokenizer(src) {
      if (this.lexer.state.inLink) return undefined
      const match = exact.exec(src)
      if (!match) return undefined
      return { type: 'issueRef', raw: match[0], number: Number(match[1] ?? match[2]) }
    },
    renderer: (token) => `<a href="#/${prefix}-${token.number}">${prefix}-${token.number}</a>`,
  }
}

const parsers = new Map<string, Marked>()

function parserFor(prefix: string): Marked {
  let parser = parsers.get(prefix)
  if (!parser) {
    parser = new Marked({ gfm: true, breaks: true })
    parser.use({ extensions: [issueRefs(prefix)] })
    parsers.set(prefix, parser)
  }
  return parser
}

let current: RenderContext | null = null

/** `https://github.com/<owner>/<repo>/issues/12` → номер задачи этого репозитория. */
function repoIssueNumber(href: string, repo: RepoRef): number | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(href)
  if (!match || match[1]!.toLowerCase() !== repo.owner.toLowerCase() || match[2]!.toLowerCase() !== repo.name.toLowerCase()) {
    return null
  }
  return Number(match[3])
}

// Узлы приходят из отдельного документа DOMPurify, поэтому сверяем nodeName, а не instanceof.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  switch (node.nodeName) {
    case 'A': {
      const href = node.getAttribute('href') ?? ''
      const issue = current && repoIssueNumber(href, current.repo)
      if (issue) {
        node.setAttribute('href', `#/${current!.prefix}-${issue}`)
        if (node.textContent === href) node.textContent = `${current!.prefix}-${issue}`
      } else if (!href.startsWith('#/')) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
      break
    }
    case 'IMG': {
      const src = node.getAttribute('src') ?? ''
      node.removeAttribute('src')
      node.setAttribute('loading', 'lazy')
      const file = current && repoFileFromUrl(src, current.repo)
      if (file) {
        node.setAttribute('data-repo-path', file.path)
        node.setAttribute('data-repo-ref', file.ref)
      } else if (src) {
        // Сторонние картинки CSP не пропустит — покажем ссылкой.
        node.setAttribute('data-external-src', src)
      }
      break
    }
    case 'INPUT':
      if (node.getAttribute('type') !== 'checkbox') node.remove()
      else node.setAttribute('disabled', '')
      break
  }
})

const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'video', 'audio'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset'],
  ALLOW_DATA_ATTR: false,
}

function sanitize(html: string, ctx: RenderContext): string {
  current = ctx
  try {
    return DOMPurify.sanitize(html, PURIFY_CONFIG)
  } finally {
    current = null
  }
}

export function renderMarkdown(markdown: string, ctx: RenderContext): string {
  return sanitize(parserFor(ctx.prefix).parse(markdown, { async: false }), ctx)
}

export function renderInlineMarkdown(markdown: string, ctx: RenderContext): string {
  return sanitize(parserFor(ctx.prefix).parseInline(markdown, { async: false }), ctx)
}
