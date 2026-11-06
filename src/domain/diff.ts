/** Построчная разница двух текстов — для истории правок описания. */

export interface DiffLine {
  type: 'same' | 'added' | 'removed'
  text: string
}

export type DiffRow = DiffLine | { type: 'skip'; count: number }

/** Больше — сравниваем «было целиком / стало целиком»: таблица растёт как произведение длин. */
const MAX_CELLS = 250_000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  // Общие начало и конец сравнивать не нужно: обычно правят середину.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  const middle =
    middleA.length * middleB.length > MAX_CELLS
      ? [...middleA.map((text) => line('removed', text)), ...middleB.map((text) => line('added', text))]
      : commonSubsequence(middleA, middleB)
  return [...a.slice(0, start).map((text) => line('same', text)), ...middle, ...a.slice(endA).map((text) => line('same', text))]
}

/** Неизменённые строки дальше `context` от правок сворачиваются в «ещё N строк». */
export function withContext(lines: readonly DiffLine[], context = 2): DiffRow[] {
  const near = new Array<boolean>(lines.length).fill(false)
  lines.forEach((current, index) => {
    if (current.type === 'same') return
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i += 1) near[i] = true
  })
  const rows: DiffRow[] = []
  lines.forEach((current, index) => {
    if (near[index]) {
      rows.push(current)
      return
    }
    const last = rows.at(-1)
    if (last?.type === 'skip') last.count += 1
    else rows.push({ type: 'skip', count: 1 })
  })
  return rows
}

function line(type: DiffLine['type'], text: string): DiffLine {
  return { type, text }
}

/** Наибольшая общая подпоследовательность строк. */
function commonSubsequence(a: string[], b: string[]): DiffLine[] {
  const width = b.length + 1
  // table[i * width + j] — длина общей подпоследовательности a[i..] и b[j..]
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push(line('same', a[i]!))
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      result.push(line('removed', a[i]!))
      i += 1
    } else {
      result.push(line('added', b[j]!))
      j += 1
    }
  }
  for (; i < a.length; i += 1) result.push(line('removed', a[i]!))
  for (; j < b.length; j += 1) result.push(line('added', b[j]!))
  return result
}
