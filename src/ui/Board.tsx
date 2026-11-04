import { useEffect, useMemo, useRef } from 'preact/hooks'
import { checklistProgress } from '../domain/body.ts'
import type { Issue } from '../domain/issue.ts'
import { BOARD_COLUMNS, STATUSES, columnOf, transitionsFrom, type BoardColumn } from '../domain/status.ts'
import { issueHref } from '../router.ts'
import { issues, savingIssues, session, setStatus } from '../store.ts'
import { Avatar, Menu, MenuItem, StatusLabel } from './common.tsx'
import { FilterBar, matchesFilters, readFilters } from './filters.tsx'
import { Icon } from './icons.tsx'

const LONG_PRESS_MS = 350
const EDGE_PX = 48
const SCROLL_STEP_PX = 14

const byUpdatedDesc = (a: Issue, b: Issue) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number

export function Board({ query }: { query: URLSearchParams }) {
  const filters = readFilters(query)
  const viewer = session.value?.viewer.login ?? null
  const visible = issues.value.filter((issue) => matchesFilters(issue, { ...filters, statuses: [] }, viewer))
  const drag = useCardDrag((number, columnId) => {
    const issue = visible.find((candidate) => candidate.number === number)
    const column = BOARD_COLUMNS.find((candidate) => candidate.id === columnId)
    if (issue && column && columnOf(issue.status).id !== column.id) void setStatus(number, column.dropStatus)
  })

  return (
    <div class="page page--board">
      <div class="page__head">
        <h1 class="page__title">Доска</h1>
        <FilterBar base="/board" query={query} filters={filters} withStatus={false} />
      </div>
      <div class="board" ref={drag.boardRef}>
        {BOARD_COLUMNS.map((column) => {
          const cards = visible.filter((issue) => column.statuses.includes(issue.status)).sort(byUpdatedDesc)
          return (
            <section key={column.id} class="column" data-column={column.id} aria-label={column.title}>
              <header class="column__head">
                <span class="column__title">{column.title}</span>
                <span class="column__count">{cards.length}</span>
              </header>
              <div class="column__cards">
                {cards.map((issue) => (
                  <Card key={issue.number} issue={issue} onPointerDown={drag.start} />
                ))}
                {!cards.length && <div class="column__empty">Нет задач</div>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function Card({ issue, onPointerDown }: { issue: Issue; onPointerDown: (event: PointerEvent, number: number) => void }) {
  const progress = checklistProgress(issue.body.checklist)
  const saving = savingIssues.value.has(issue.number)
  return (
    <article
      class={`card${saving ? ' is-saving' : ''}`}
      data-number={issue.number}
      onPointerDown={(event) => onPointerDown(event, issue.number)}
      onContextMenu={(event) => {
        // долгое нажатие на телефоне — это перетаскивание, а не меню браузера
        if ('pointerType' in event && event.pointerType !== 'mouse') event.preventDefault()
      }}
    >
      <div class="card__top">
        <span class="card__key">{issue.key}</span>
        {issue.milestone && (
          <span class="tag tag--milestone">
            <Icon name="flag" size={12} />
            Веха
          </span>
        )}
        <span class="spacer" />
        <CardMenu issue={issue} />
      </div>
      <a class="card__title" href={issueHref(issue.number)} draggable={false}>
        {issue.title}
      </a>
      <div class="card__bottom">
        {issue.status === 'needInfo' && <StatusLabel status="needInfo" size="s" />}
        {progress.total > 0 && (
          <span class={`card__meta${progress.done === progress.total ? ' is-done' : ''}`} title="Чеклист">
            <Icon name="checklist" size={14} />
            {progress.done}/{progress.total}
          </span>
        )}
        {issue.comments > 0 && (
          <span class="card__meta" title="Комментарии">
            <Icon name="comment" size={14} />
            {issue.comments}
          </span>
        )}
        {issue.body.links.length > 0 && (
          <span class="card__meta" title="Связи">
            <Icon name="link" size={14} />
            {issue.body.links.length}
          </span>
        )}
        <span class="spacer" />
        {issue.assignee && <Avatar login={issue.assignee} />}
      </div>
    </article>
  )
}

/** Смена статуса без перетаскивания — основной способ на телефоне. */
function CardMenu({ issue }: { issue: Issue }) {
  return (
    <Menu triggerClass="btn btn--icon btn--s card__menu" title="Сменить статус" align="end" label={<Icon name="more" />}>
      {(close) =>
        transitionsFrom(issue.status).map((next) => (
          <MenuItem key={next} onSelect={() => (close(), void setStatus(issue.number, next))}>
            <span class={`dot dot--${STATUSES[next].tone}`} />
            {STATUSES[next].action}
          </MenuItem>
        ))
      }
    </Menu>
  )
}

interface DragState {
  number: number
  card: HTMLElement
  pointerId: number
  touch: boolean
  startX: number
  startY: number
  x: number
  y: number
  offsetX: number
  offsetY: number
  active: boolean
  ghost: HTMLElement | null
  over: HTMLElement | null
  timer: ReturnType<typeof setTimeout> | undefined
  frame: number
}

/**
 * Перетаскивание карточек на pointer events: мышью — сразу после сдвига,
 * пальцем — после долгого нажатия (короткий свайп остаётся прокруткой).
 */
function useCardDrag(onDrop: (number: number, column: BoardColumn['id']) => void) {
  const boardRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  // Обработчики создаём один раз: они снимаются с window той же ссылкой, что и вешались.
  const controller = useMemo(() => createDragController(boardRef, dropRef), [])
  useEffect(() => () => controller.cancel(), [controller])
  return { boardRef, start: controller.start }
}

function createDragController(
  boardRef: { current: HTMLDivElement | null },
  dropRef: { current: (number: number, column: BoardColumn['id']) => void },
) {
  let state: DragState | null = null

  const preventScroll = (event: TouchEvent) => event.preventDefault()

  const columnAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('.column') ?? null

  function place(drag: DragState) {
    drag.ghost!.style.transform = `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px) rotate(1.5deg)`
    const over = columnAt(drag.x, drag.y)
    if (over !== drag.over) {
      drag.over?.classList.remove('is-drop-target')
      over?.classList.add('is-drop-target')
      drag.over = over
    }
  }

  /** Прокрутка у краёв: страница — по вертикали, доска — по горизонтали (на телефоне). */
  function autoScroll() {
    const drag = state
    if (!drag?.active) return
    const board = boardRef.current
    if (drag.y < EDGE_PX) window.scrollBy(0, -SCROLL_STEP_PX)
    else if (drag.y > window.innerHeight - EDGE_PX) window.scrollBy(0, SCROLL_STEP_PX)
    if (board && board.scrollWidth > board.clientWidth) {
      const rect = board.getBoundingClientRect()
      if (drag.x < rect.left + EDGE_PX) board.scrollLeft -= SCROLL_STEP_PX
      else if (drag.x > rect.right - EDGE_PX) board.scrollLeft += SCROLL_STEP_PX
    }
    place(drag)
    drag.frame = requestAnimationFrame(autoScroll)
  }

  function activate(drag: DragState) {
    drag.active = true
    const rect = drag.card.getBoundingClientRect()
    drag.offsetX = drag.x - rect.left
    drag.offsetY = drag.y - rect.top
    const ghost = drag.card.cloneNode(true) as HTMLElement
    ghost.classList.add('card--ghost')
    ghost.style.width = `${rect.width}px`
    document.body.appendChild(ghost)
    drag.ghost = ghost
    drag.card.classList.add('card--placeholder')
    document.body.classList.add('is-dragging')
    if (drag.touch) {
      document.addEventListener('touchmove', preventScroll, { passive: false })
      navigator.vibrate?.(10)
    }
    place(drag)
    drag.frame = requestAnimationFrame(autoScroll)
  }

  function finish(drop: boolean) {
    const drag = state
    if (!drag) return
    state = null
    clearTimeout(drag.timer)
    cancelAnimationFrame(drag.frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey)
    document.removeEventListener('touchmove', preventScroll)
    if (!drag.active) return
    drag.ghost?.remove()
    drag.card.classList.remove('card--placeholder')
    drag.over?.classList.remove('is-drop-target')
    document.body.classList.remove('is-dragging')
    // клик после отпускания мыши не должен открыть задачу
    const swallow = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    const column = drop ? columnAt(drag.x, drag.y)?.dataset.column : undefined
    if (column) dropRef.current(drag.number, column as BoardColumn['id'])
  }

  function onMove(event: PointerEvent) {
    const drag = state
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.active) {
      const distance = Math.hypot(drag.x - drag.startX, drag.y - drag.startY)
      if (drag.touch) {
        if (distance > 10) finish(false) // палец поехал до долгого нажатия — это прокрутка
        return
      }
      if (distance < 5) return
      activate(drag)
    }
    event.preventDefault()
  }

  function onUp(event: PointerEvent) {
    if (state && event.pointerId === state.pointerId) finish(true)
  }

  function onCancel() {
    finish(false)
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') finish(false)
  }

  function start(event: PointerEvent, number: number) {
    if (event.button !== 0 || !event.isPrimary || state) return
    if ((event.target as Element).closest('button, .menu')) return
    const drag: DragState = {
      number,
      card: event.currentTarget as HTMLElement,
      pointerId: event.pointerId,
      touch: event.pointerType === 'touch',
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      offsetX: 0,
      offsetY: 0,
      active: false,
      ghost: null,
      over: null,
      timer: undefined,
      frame: 0,
    }
    state = drag
    if (drag.touch) drag.timer = setTimeout(() => state === drag && activate(drag), LONG_PRESS_MS)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }

  return { start, cancel: () => finish(false) }
}
