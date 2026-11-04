/**
 * Собирает данные для демо-режима сайта из выгрузки Трекера — ровно то,
 * что окажется в GitHub после переноса. Пишет в `.demo/` (в git не попадает).
 *
 *   node scripts/demo-fixture.ts [--config migration.config.json]
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildTarget, targetStats, type MigrationConfig, type TrackerExport } from './lib/target.ts'

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'migration.config.json' },
    // кем «вошли» в демо; по умолчанию — первый пользователь из настроек
    viewer: { type: 'string' },
  },
})
const config = JSON.parse(readFileSync(values.config!, 'utf8')) as MigrationConfig
const data = JSON.parse(readFileSync(config.exportFile, 'utf8')) as TrackerExport & {
  users?: { uid?: number; login: string; display: string }[]
}

// Перенос «был» час назад: правки в демо сразу видны как свежие изменения.
const migratedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const state = buildTarget(data, config, migratedAt)

// Имена людей — из выгрузки, по id пользователя Трекера.
const names = new Map<string, string>()
for (const issue of data.issues as unknown as { assignee?: { id: string; display: string } }[]) {
  if (issue.assignee) names.set(String(issue.assignee.id), issue.assignee.display)
}
const users = Object.entries(config.users).map(([trackerId, login], index) => ({
  login,
  id: index + 1,
  name: names.get(trackerId) ?? login,
}))
const viewer = users.find((user) => user.login === values.viewer) ?? users[0]!

const issues = state.issues.map((issue) => {
  const created = migratedAt
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login) => users.find((user) => user.login === login)!),
    user: viewer,
    comments: issue.comments.length,
    created_at: created,
    updated_at: created,
    closed_at: issue.state === 'closed' ? created : null,
    html_url: `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}`,
    _comments: issue.comments.map((comment, commentIndex) => ({
      id: issue.number * 100 + commentIndex,
      body: comment.body,
      user: viewer,
      created_at: created,
      updated_at: created,
      html_url: `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}#issuecomment-${issue.number * 100 + commentIndex}`,
    })),
  }
})

const outDir = resolve('.demo')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'files'), { recursive: true })
for (const file of state.files) {
  const target = join(outDir, 'files', file.path)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(file.localPath, target)
}
writeFileSync(
  join(outDir, 'fixture.json'),
  JSON.stringify({
    repo: { owner: config.owner, name: config.repo, default_branch: config.branch },
    viewer,
    users,
    labels: state.labels,
    issues,
    files: state.files.map((file) => file.path),
  }),
)

const stats = targetStats(state)
console.log(`демо-данные: ${join(outDir, 'fixture.json')}`)
console.log(
  `задач ${stats.issues}, комментариев ${stats.comments}, пунктов чеклистов ${stats.checklistItems}, ` +
    `связей ${stats.linkRefs}, файлов ${stats.files} (не перенесено ${stats.missingFiles})`,
)
if (state.warnings.length) console.log(`предупреждения:\n  ${state.warnings.join('\n  ')}`)
