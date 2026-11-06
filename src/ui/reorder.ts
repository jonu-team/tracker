import { useEffect, useMemo, useRef } from 'preact/hooks'

const START_PX = 4
const EDGE_PX = 48
const SCROLL_STEP_PX = 14

/** Куда бросили строку: перед строкой с этим `data-index` или после неё. */
export interface DropTarget {
  index: number
  place: 'before' | 'after'
}

interface DragState<T> {
  payload: T
  row: HTMLElement
  pointerId: number
  touch: boolean
  startX: number
  startY: number
  startScroll: number
  /** Где схватили строку: от её верха до указателя. */
  grabY: number
  x: number
  y: number
  active: boolean
  target: DropTarget | null
  frame: number
}

/**
 * Перестановка строк списка за ручку, на pointer events — мышью и пальцем
 * одинаково: у ручки `touch-action: none`, поэтому палец на ней не листает
 * страницу, а сразу тащит строку. Строка едет за указателем, соседи
 * расступаются — пустая щель показывает, куда она встанет; Esc отменяет.
 * Строки — прямые потомки списка с `data-index`, список — их offsetParent
 * (`position: relative`). Бросить можно только между строками на экране.
 */
export function useReorder<T>(onDrop: (payload: T, target: DropTarget) => void) {
  const listRef = useRef<HTMLUListElement>(null)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  // Обработчики создаём один раз: они снимаются с window той же ссылкой, что и вешались.
  const controller = useMemo(() => createReorder(listRef, dropRef), [])
  useEffect(() => () => controller.cancel(), [controller])
  return { listRef, start: controller.start }
}

function createReorder<T>(
  listRef: { current: HTMLElement | null },
  dropRef: { current: (payload: T, target: DropTarget) => void },
) {
  let state: DragState<T> | null = null

  const rowsOf = (list: HTMLElement | null) =>
    [...(list?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.index !== undefined)

  function shift(row: HTMLElement, px: number) {
    const transform = px ? `translateY(${px}px)` : ''
    if (row.style.transform !== transform) row.style.transform = transform
  }

  function place(drag: DragState<T>) {
    const list = listRef.current
    shift(drag.row, drag.y - drag.startY + window.scrollY - drag.startScroll)
    const rows = rowsOf(list)
    const own = rows.indexOf(drag.row)
    const others = rows.filter((row) => row !== drag.row)
    if (!list || own < 0) {
      drag.target = null
      for (const row of others) shift(row, 0)
      return
    }
    // Щель — перед первой строкой, чья середина ниже середины перетаскиваемой.
    // Соседей меряем по раскладке (offsetTop), а не по экрану: их сдвиги и
    // анимация сдвигов на неё не влияют.
    const height = drag.row.offsetHeight
    const center = drag.y - drag.grabY + height / 2
    const top = list.getBoundingClientRect().top
    let gap = others.findIndex((row) => center < top + row.offsetTop + row.offsetHeight / 2)
    if (gap < 0) gap = others.length
    // Между щелью и старым местом соседи сдвигаются на высоту строки.
    others.forEach((row, i) => shift(row, gap <= i && i < own ? height : own <= i && i < gap ? -height : 0))
    const anchor = gap < others.length ? others[gap] : others.at(-1)
    drag.target =
      gap === own || !anchor ? null : { index: Number(anchor.dataset.index), place: gap < others.length ? 'before' : 'after' }
  }

  /** Прокрутка страницы, когда указатель у верхнего или нижнего края окна. */
  function autoScroll() {
    const drag = state
    if (!drag?.active) return
    if (drag.y < EDGE_PX) window.scrollBy(0, -SCROLL_STEP_PX)
    else if (drag.y > window.innerHeight - EDGE_PX) window.scrollBy(0, SCROLL_STEP_PX)
    place(drag)
    drag.frame = requestAnimationFrame(autoScroll)
  }

  function activate(drag: DragState<T>) {
    drag.active = true
    drag.row.classList.add('is-dragged')
    listRef.current?.classList.add('is-reordering')
    document.body.classList.add('is-dragging')
    if (drag.touch) navigator.vibrate?.(10)
    place(drag)
    drag.frame = requestAnimationFrame(autoScroll)
  }

  function finish(drop: boolean) {
    const drag = state
    if (!drag) return
    state = null
    cancelAnimationFrame(drag.frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey)
    if (!drag.active) return
    // Сдвиги снимаем без анимации: новый порядок отрисуется до следующего кадра.
    listRef.current?.classList.remove('is-reordering')
    drag.row.classList.remove('is-dragged')
    for (const row of [drag.row, ...rowsOf(listRef.current)]) shift(row, 0)
    document.body.classList.remove('is-dragging')
    if (drop && drag.target && drag.row.isConnected) dropRef.current(drag.payload, drag.target)
  }

  function onMove(event: PointerEvent) {
    const drag = state
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (drag.active) place(drag)
    else if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= START_PX) activate(drag)
    else return
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

  /** Вешается на pointerdown ручки внутри строки. */
  function start(event: PointerEvent, payload: T) {
    if (event.button !== 0 || !event.isPrimary || state) return
    const row = (event.currentTarget as Element).closest<HTMLElement>('[data-index]')
    if (!row || row.parentElement !== listRef.current) return
    // без выделения текста и без смены фокуса
    event.preventDefault()
    state = {
      payload,
      row,
      pointerId: event.pointerId,
      touch: event.pointerType === 'touch',
      startX: event.clientX,
      startY: event.clientY,
      startScroll: window.scrollY,
      grabY: event.clientY - row.getBoundingClientRect().top,
      x: event.clientX,
      y: event.clientY,
      active: false,
      target: null,
      frame: 0,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }

  return { start, cancel: () => finish(false) }
}
