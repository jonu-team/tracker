import type { Attachment, ChecklistItem, IssueBody } from './body.ts'

/**
 * Правки тела задачи — чистые функции. Их применяют дважды: к локальной
 * копии (мгновенный отклик) и к свежему телу с сервера прямо перед записью,
 * чтобы не затереть параллельную правку соседа.
 */

/** Ссылка на пункт чеклиста. У пунктов из GitHub может не быть id — тогда ищем по тексту. */
export interface ItemRef {
  id: string
  text: string
  index: number
}

export function itemRef(item: ChecklistItem, index: number): ItemRef {
  return { id: item.id, text: item.text, index }
}

export function findItem(items: readonly ChecklistItem[], ref: ItemRef): number {
  if (ref.id) {
    const byId = items.findIndex((item) => item.id === ref.id)
    if (byId >= 0) return byId
  }
  let best = -1
  items.forEach((item, index) => {
    if (item.text === ref.text && (best < 0 || Math.abs(index - ref.index) < Math.abs(best - ref.index))) best = index
  })
  return best
}

export function updateItem(ref: ItemRef, patch: Partial<Omit<ChecklistItem, 'id'>>) {
  return (body: IssueBody): IssueBody => {
    const index = findItem(body.checklist, ref)
    if (index < 0) return body
    const next = { ...body.checklist[index]!, ...patch }
    for (const key of ['assignee', 'due'] as const) if (!next[key]) delete next[key]
    return { ...body, checklist: body.checklist.with(index, next) }
  }
}

export function addItem(item: ChecklistItem) {
  return (body: IssueBody): IssueBody => ({ ...body, checklist: [...body.checklist, item] })
}

export function removeItem(ref: ItemRef) {
  return (body: IssueBody): IssueBody => {
    const index = findItem(body.checklist, ref)
    return index < 0 ? body : { ...body, checklist: body.checklist.toSpliced(index, 1) }
  }
}

export function addLink(number: number) {
  return (body: IssueBody): IssueBody =>
    body.links.includes(number) ? body : { ...body, links: [...body.links, number].sort((a, b) => a - b) }
}

export function removeLink(number: number) {
  return (body: IssueBody): IssueBody => ({ ...body, links: body.links.filter((n) => n !== number) })
}

export function setDescription(description: string) {
  return (body: IssueBody): IssueBody => ({ ...body, description })
}

export function addAttachment(file: Attachment) {
  return (body: IssueBody): IssueBody => ({ ...body, attachments: [...body.attachments, file] })
}

export function removeAttachment(url: string) {
  return (body: IssueBody): IssueBody => ({ ...body, attachments: body.attachments.filter((file) => file.url !== url) })
}
