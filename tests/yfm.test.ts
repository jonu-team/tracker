import { describe, expect, it } from 'vitest'
import { yfmToGfm, type YfmContext } from '../scripts/lib/yfm.ts'

const ctx: YfmContext = {
  attachment: (id) =>
    id === '404' ? null : id === '17' ? { url: `https://files/${id}.png`, note: 'миниатюра' } : { url: `https://files/${id}.png` },
  missing: (id, name) => `_[нет файла ${name} (${id})]_`,
  hashRefRepo: 'org/code',
  queue: 'DEV',
  issueUrl: (number) => `https://github.com/org/tasks/issues/${number}`,
}

const convert = (text: string) => yfmToGfm(text, ctx)

describe('YFM → GFM', () => {
  it('переписывает картинки-вложения и убирает размер', () => {
    const result = convert('Экран: ![image.png](/ajax/v2/attachments/12?inline=true =800x600) и всё')
    expect(result.markdown).toBe('Экран: ![image.png](https://files/12.png) и всё')
    expect(result.attachments).toEqual(['12'])
  })

  it('помечает миниатюры и недоступные файлы', () => {
    expect(convert('![a.png](/ajax/v2/attachments/17?inline=true =1x1)').markdown).toBe(
      '![a.png](https://files/17.png) _(миниатюра)_',
    )
    expect(convert('![b.png](/ajax/v2/attachments/404?inline=true)').markdown).toBe('_[нет файла b.png (404)]_')
  })

  it('не трогает обычные ссылки, автоссылки и URL с решёткой', () => {
    const text = '[#61](https://github.com/org/code/pull/61), <https://disk.example/i/abc>, https://site.example/page#55'
    expect(convert(text).markdown).toBe(text)
  })

  it('голые #123 ведут на PR репозитория с кодом', () => {
    expect(convert('PR #55 и (#51); ## Заголовок #7').markdown).toBe(
      'PR [#55](https://github.com/org/code/pull/55) и ([#51](https://github.com/org/code/pull/51)); ## Заголовок [#7](https://github.com/org/code/pull/7)',
    )
    expect(convert('&#8203; и a#1').markdown).toBe('&#8203; и a#1')
  })

  it('переводит ссылки на задачи очереди в Трекере на issue', () => {
    expect(convert('см. https://tracker.yandex.ru/DEV-14 и https://tracker.yandex.ru/OTHER-2').markdown).toBe(
      'см. #14 и https://tracker.yandex.ru/OTHER-2',
    )
    expect(convert('[задача](https://tracker.yandex.ru/DEV-7)').markdown).toBe('[задача](https://github.com/org/tasks/issues/7)')
  })

  it('экранирует HTML вне кода и не трогает код', () => {
    const text = 'кнопка <button> и `<img src={x}>`\n\n```\n<div>#12 @user</div>\n```\n'
    expect(convert(text).markdown).toBe('кнопка &lt;button> и `<img src={x}>`\n\n```\n<div>#12 @user</div>\n```')
  })

  it('обезвреживает упоминания, но не почту', () => {
    expect(convert('спросить @someone, почта a@b.ru').markdown).toBe('спросить @&#8203;someone, почта a@b.ru')
  })

  it('делает список из отметок YFM без маркера', () => {
    expect(convert('[ ] первое\n\n[x] второе\n- [ ] уже список').markdown).toBe(
      '- [ ] первое\n\n- [x] второе\n- [ ] уже список',
    )
  })

  it('предупреждает о разметке без аналога в GitHub', () => {
    expect(convert('{% cut "Подробнее" %}текст{% endcut %}').warnings).toHaveLength(1)
    expect(convert('обычный текст').warnings).toEqual([])
  })
})
