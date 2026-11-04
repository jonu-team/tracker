/**
 * Перенос очереди Яндекс Трекера в GitHub Issues.
 *
 *   node scripts/migrate.ts plan    — сухой прогон: сводка и тела задач в migration-state/plan/;
 *                                     с GITHUB_TOKEN ещё и проверка репозитория
 *   node scripts/migrate.ts apply   — перенос и сверка; перезапуск не создаёт дублей
 *   node scripts/migrate.ts verify  — сверка GitHub с выгрузкой по счётчикам и по каждой задаче
 *
 * Параметры: --config migration.config.json. Токен — в переменной GITHUB_TOKEN
 * (права на репозиторий с задачами: Issues и Contents — чтение и запись).
 *
 * Номера сохраняются: в пустом репозитории задачи создаются по порядку,
 * поэтому DEV-N = #N. Если номер не совпал, перенос останавливается.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { GitHubClient } from '../src/lib/github.ts'
import { applyMigration, preflight, verifyMigration, type MigrationContext } from './lib/migration.ts'
import { buildTarget, targetStats, type MigrationConfig, type TargetState, type TrackerExport } from './lib/target.ts'

const WRITE_PAUSE_MS = 1100
const PLAN_DIR = join('migration-state', 'plan')

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { config: { type: 'string', default: 'migration.config.json' } },
})
const command = positionals[0]
if (!command || !['plan', 'apply', 'verify'].includes(command)) {
  console.error('Использование: node scripts/migrate.ts plan|apply|verify [--config migration.config.json]')
  process.exit(2)
}

const config = JSON.parse(readFileSync(values.config!, 'utf8')) as MigrationConfig
const source = JSON.parse(readFileSync(config.exportFile, 'utf8')) as TrackerExport
const target = buildTarget(source, config, new Date().toISOString())
const token = process.env.GITHUB_TOKEN
const context: MigrationContext | null = token
  ? {
      client: new GitHubClient({ token, repo: { owner: config.owner, name: config.repo } }),
      config,
      source,
      target,
      log: (line) => console.log(line),
      pauseMs: WRITE_PAUSE_MS,
    }
  : null

function printPlan(state: TargetState): void {
  const stats = targetStats(state)
  console.log(`Выгрузка: ${config.exportFile} (от ${source.exportedAt})`)
  console.log(`Репозиторий: ${config.owner}/${config.repo}, ветка ${config.branch}\n`)
  console.log(
    `Задач ${stats.issues}: открыто ${stats.byStatus.open}, нужна информация ${stats.byStatus.needInfo}, ` +
      `в работе ${stats.byStatus.inProgress}, закрыто ${stats.byStatus.closed}; вех ${stats.milestones}`,
  )
  console.log(`Исполнители: ${Object.entries(stats.assigned).map(([login, n]) => `${login} ${n}`).join(', ')}`)
  console.log(`С описанием ${stats.withDescription}, комментариев ${stats.comments}`)
  console.log(
    `Чеклисты: пунктов ${stats.checklistItems}, отмечено ${stats.checklistChecked}, ` +
      `с исполнителем ${stats.checklistWithAssignee}, со сроком ${stats.checklistWithDue}`,
  )
  console.log(`Связей (ссылок с двух сторон) ${stats.linkRefs}`)
  console.log(`Файлов ${stats.files}, не переносится ${stats.missingFiles}, в разделе «Вложения» ${stats.attachmentsInBody}`)
  for (const file of state.missingFiles) console.log(`  нет файла: ${file.issueKey}, вложение ${file.trackerId} (${file.name})`)
  if (state.warnings.length) console.log(`Предупреждения:\n  ${state.warnings.join('\n  ')}`)
  console.log('')
  for (const issue of state.issues) {
    const parts = [
      issue.status,
      issue.assignees[0] ?? '—',
      issue.parsed.checklist.length ? `чеклист ${issue.parsed.checklist.length}` : '',
      issue.parsed.links.length ? `связи ${issue.parsed.links.map((n) => `#${n}`).join(' ')}` : '',
      issue.comments.length ? `комм. ${issue.comments.length}` : '',
      issue.parsed.attachments.length ? `вложений ${issue.parsed.attachments.length}` : '',
    ].filter(Boolean)
    console.log(`  #${issue.number} ${issue.key} ${issue.title.slice(0, 60)} · ${parts.join(' · ')}`)
  }
  mkdirSync(PLAN_DIR, { recursive: true })
  for (const issue of state.issues) {
    const comments = issue.comments.map((comment) => `\n\n---- комментарий ${comment.originId}\n\n${comment.body}`).join('')
    writeFileSync(join(PLAN_DIR, `${issue.key}.md`), `# ${issue.title}\n\n${issue.body}${comments}\n`)
  }
  console.log(`\nТела задач для просмотра: ${PLAN_DIR}/`)
}

async function verifyAndReport(ctx: MigrationContext): Promise<boolean> {
  const result = await verifyMigration(ctx)
  console.log('Показатель'.padEnd(44) + 'Трекер'.padStart(8) + 'GitHub'.padStart(10))
  for (const row of result.rows) {
    console.log(`${row.name.padEnd(44)}${row.expected.padStart(8)}${row.actual.padStart(10)}  ${row.same ? '✓' : '✗'}`)
  }
  if (result.extraIssues) console.log(`\nНовых задач после переноса: ${result.extraIssues}`)
  console.log(
    result.ok
      ? '\nВсё совпало.'
      : `\nРасхождения (${result.mismatches.length}):\n  ${result.mismatches.join('\n  ')}`,
  )
  return result.ok
}

if (command === 'plan') {
  printPlan(target)
  if (!context) {
    console.log('\nБез GITHUB_TOKEN репозиторий не проверяю.')
  } else {
    const problems = await preflight(context)
    console.log(problems.length ? `\nК переносу не готово:\n  ${problems.join('\n  ')}` : '\nРепозиторий готов к переносу.')
  }
} else {
  if (!context) {
    console.error('Нужен токен в GITHUB_TOKEN')
    process.exit(2)
  }
  if (command === 'apply') {
    const problems = await preflight(context)
    if (problems.length) {
      console.error(`Перенос остановлен:\n  ${problems.join('\n  ')}`)
      process.exit(1)
    }
    await applyMigration(context)
    console.log('\nПеренос закончен, сверяю…\n')
  }
  process.exit((await verifyAndReport(context)) ? 0 : 1)
}
