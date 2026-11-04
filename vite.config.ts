import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'

const DEV_PORT = 5190

/**
 * CSP задаём мета-тегом: GitHub Pages не даёт настроить заголовки.
 * Наружу страница ходит только в api.github.com; картинки из репозитория
 * приходят через API и показываются как blob:.
 */
function contentSecurityPolicy(dev: boolean): string {
  const directives: Record<string, string> = {
    'default-src': "'none'",
    'script-src': "'self'",
    // Vite в dev-режиме вставляет стили через <style>, в сборке они в файле.
    'style-src': dev ? "'self' 'unsafe-inline'" : "'self'",
    'img-src': "'self' blob: data:",
    'connect-src': dev
      ? `'self' ws://127.0.0.1:${DEV_PORT} ws://localhost:${DEV_PORT} https://api.github.com`
      : 'https://api.github.com',
    'font-src': "'self'",
    'manifest-src': "'self'",
    'base-uri': "'none'",
    'form-action': "'none'",
    'object-src': "'none'",
  }
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ')
}

function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) =>
        html.replace(
          '<!-- csp -->',
          `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(Boolean(ctx.server))}">`,
        ),
    },
  }
}

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Демо-режим (`npm run demo`): отдаёт локальную выгрузку из `.demo/` по пути
 * `/__demo/`. Работает только в dev-сервере — в сборку данные не попадают.
 */
function demoData(): Plugin {
  const root = resolve('.demo')
  return {
    name: 'demo-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__demo/', async (req, res) => {
        const relative = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '')
        const file = normalize(join(root, relative))
        if (!file.startsWith(root + sep)) {
          res.statusCode = 403
          res.end()
          return
        }
        try {
          const data = await readFile(file)
          res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
          res.setHeader('Cache-Control', 'no-store')
          res.end(data)
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [preact(), cspMeta(), demoData()],
  build: {
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
  },
})
