import { useEffect, useRef, useState } from 'preact/hooks'
import { appendQuote } from './drafts.ts'
import { Icon } from './icons.tsx'

/**
 * Ответ с цитатой: выделите текст в описании или комментарии — рядом
 * появится «Ответить», и фрагмент уйдёт цитатой в черновик комментария.
 * То же по клавише R, как в GitHub.
 */

const BUTTON_WIDTH = 112
const GAP = 8

interface Anchor {
  left: number
  top: number
}

function quotableContainer(range: Range): Element | null {
  const elementOf = (node: Node) => (node instanceof Element ? node : node.parentElement)
  const start = elementOf(range.startContainer)?.closest('[data-quotable]')
  const end = elementOf(range.endContainer)?.closest('[data-quotable]')
  return start && start === end ? start : null
}

export function QuoteReply({ issueNumber }: { issueNumber: number }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const range = useRef<Range | null>(null)

  useEffect(() => {
    let frame = 0
    // на телефоне над выделением системное меню — кнопку ставим под выделением
    const touchScreen = matchMedia('(pointer: coarse)')

    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const selection = document.getSelection()
        const current = selection && selection.rangeCount ? selection.getRangeAt(0) : null
        if (!current || current.collapsed || !selection!.toString().trim() || !quotableContainer(current)) {
          range.current = null
          setAnchor(null)
          return
        }
        range.current = current.cloneRange()
        const rects = current.getClientRects()
        const last = rects[rects.length - 1] ?? current.getBoundingClientRect()
        const left = Math.min(Math.max(GAP, last.right - BUTTON_WIDTH / 2), window.innerWidth - BUTTON_WIDTH - GAP)
        const above = last.top - 36 - GAP
        setAnchor({ left, top: touchScreen.matches || above < GAP ? last.bottom + GAP : above })
      })
    }

    document.addEventListener('selectionchange', update)
    window.addEventListener('scroll', update, { passive: true, capture: true })
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('scroll', update, { capture: true })
      window.removeEventListener('resize', update)
    }
  }, [])

  async function quote() {
    const selected = range.current
    if (!selected) return
    const { selectionToMarkdown } = await import('./quote.ts')
    const markdown = selectionToMarkdown(selected)
    if (!markdown) return
    appendQuote(issueNumber, markdown)
    document.getSelection()?.removeAllRanges()
    range.current = null
    setAnchor(null)
    document.querySelector('.comment-form')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'r' || event.metaKey || event.ctrlKey || event.altKey || !range.current) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      void quote()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [issueNumber])

  if (!anchor) return null
  return (
    <button
      type="button"
      class="quote-button"
      style={{ left: `${anchor.left}px`, top: `${anchor.top}px` }}
      title="Процитировать в комментарии (R)"
      // кнопка не должна снимать выделение
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void quote()}
    >
      <Icon name="reply" size={14} />
      Ответить
    </button>
  )
}
