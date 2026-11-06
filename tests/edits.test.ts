import { describe, expect, it } from 'vitest'
import { emptyBody, type ChecklistItem, type IssueBody } from '../src/domain/body.ts'
import { itemRef, moveItem, type ItemRef } from '../src/domain/edits.ts'

const item = (text: string, extra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: text.toLowerCase(),
  text,
  checked: false,
  ...extra,
})

const body = (...texts: string[]): IssueBody => ({ ...emptyBody(), checklist: texts.map((text) => item(text)) })
const texts = (value: IssueBody) => value.checklist.map((entry) => entry.text)
const ref = (value: IssueBody, text: string): ItemRef => {
  const index = value.checklist.findIndex((entry) => entry.text === text)
  return itemRef(value.checklist[index]!, index)
}

describe('перестановка пунктов чеклиста', () => {
  const abcd = body('A', 'B', 'C', 'D')

  it('ставит пункт перед соседом и после него — вверх и вниз', () => {
    expect(texts(moveItem(ref(abcd, 'A'), ref(abcd, 'C'), 'before')(abcd))).toEqual(['B', 'A', 'C', 'D'])
    expect(texts(moveItem(ref(abcd, 'A'), ref(abcd, 'C'), 'after')(abcd))).toEqual(['B', 'C', 'A', 'D'])
    expect(texts(moveItem(ref(abcd, 'D'), ref(abcd, 'B'), 'before')(abcd))).toEqual(['A', 'D', 'B', 'C'])
    expect(texts(moveItem(ref(abcd, 'D'), ref(abcd, 'A'), 'before')(abcd))).toEqual(['D', 'A', 'B', 'C'])
    expect(texts(moveItem(ref(abcd, 'A'), ref(abcd, 'D'), 'after')(abcd))).toEqual(['B', 'C', 'D', 'A'])
  })

  it('без перемещения возвращает то же тело — записи не будет', () => {
    expect(moveItem(ref(abcd, 'B'), ref(abcd, 'C'), 'before')(abcd)).toBe(abcd)
    expect(moveItem(ref(abcd, 'B'), ref(abcd, 'A'), 'after')(abcd)).toBe(abcd)
    expect(moveItem(ref(abcd, 'B'), ref(abcd, 'B'), 'after')(abcd)).toBe(abcd)
  })

  it('не теряет отметку, исполнителя и срок', () => {
    const value: IssueBody = {
      ...emptyBody(),
      checklist: [item('A'), item('B', { checked: true, assignee: 'alice', due: '2026-11-10' })],
    }
    const moved = moveItem(ref(value, 'B'), ref(value, 'A'), 'before')(value)
    expect(moved.checklist).toEqual([value.checklist[1], value.checklist[0]])
  })

  it('ложится на свежее тело, где сосед успел поменять пункты', () => {
    const local = body('A', 'B', 'C')
    const change = moveItem(ref(local, 'C'), ref(local, 'A'), 'before')
    // на сервере тем временем добавили пункт в начало и удалили B
    const fresh: IssueBody = { ...emptyBody(), checklist: [item('New'), item('A'), item('C')] }
    expect(texts(change(fresh))).toEqual(['New', 'C', 'A'])
    // а если пункт уже удалили — ничего не делаем
    expect(change(body('A', 'B'))).toEqual(body('A', 'B'))
  })

  it('перескакивает через скрытые пункты: опора — ближайший видимый сосед', () => {
    const value = body('A', 'Done1', 'Done2', 'B')
    // выполненные скрыты, видны A и B; «B выше» — это перед A
    expect(texts(moveItem(ref(value, 'B'), ref(value, 'A'), 'before')(value))).toEqual(['B', 'A', 'Done1', 'Done2'])
    // «A ниже» — это после B
    expect(texts(moveItem(ref(value, 'A'), ref(value, 'B'), 'after')(value))).toEqual(['Done1', 'Done2', 'B', 'A'])
  })

  it('находит пункты без id (добавлены в GitHub) по тексту', () => {
    const value: IssueBody = { ...emptyBody(), checklist: [item('A', { id: '' }), item('B', { id: '' })] }
    expect(texts(moveItem(itemRef(value.checklist[1]!, 1), itemRef(value.checklist[0]!, 0), 'before')(value))).toEqual(['B', 'A'])
  })
})
