import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { getDiff, validateDiffArgs } from './diff.ts'
import { loadViewed, markViewed, unmarkViewed } from './viewed.ts'
import { insertComment, removeComment } from './comment.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  commentRequestSchema,
  commentDeleteSchema,
} from '../shared/types.ts'
import type { DiffResponse, OkResponse, ErrorResponse } from '../shared/types.ts'

const diffArgs = process.argv.slice(2)
if (diffArgs.length === 0) diffArgs.push('-r', '@')
const port = Number(process.env['PORT']) || 3742
const cwd = process.cwd()
await validateDiffArgs(diffArgs)

const app = new Hono()

app.get('/api/diff', async (c) => {
  const { patch, fileHashes } = await getDiff(diffArgs)
  const viewed = await loadViewed(cwd, fileHashes)
  return c.json({
    patch,
    revset: diffArgs.join(' '),
    fileHashes,
    viewed,
  } satisfies DiffResponse)
})

app.post('/api/viewed', zValidator('json', viewedRequestSchema), async (c) => {
  const { file, hash } = c.req.valid('json')
  await markViewed(cwd, file, hash)
  return c.json({ ok: true } satisfies OkResponse)
})

app.delete('/api/viewed', zValidator('json', viewedDeleteSchema), async (c) => {
  const { file, hash } = c.req.valid('json')
  await unmarkViewed(cwd, file, hash)
  return c.json({ ok: true } satisfies OkResponse)
})

app.post('/api/comment', zValidator('json', commentRequestSchema), async (c) => {
  const { file, afterLine, text } = c.req.valid('json')
  await insertComment(cwd, file, afterLine, text)
  return c.json({ ok: true } satisfies OkResponse)
})

app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
  const { file, line } = c.req.valid('json')
  await removeComment(cwd, file, line)
  return c.json({ ok: true } satisfies OkResponse)
})

// Serve built frontend assets in production mode
const distDir = join(import.meta.dirname, '..', 'dist')

app.use('*', serveStatic({ root: relative(cwd, distDir) }))

// SPA fallback
app.get('*', async (c) => {
  const html = await readFile(join(distDir, 'index.html'), 'utf-8')
  return c.html(html)
})

app.onError((err, c) => {
  return c.json({ error: err.message } satisfies ErrorResponse, 500)
})

serve({ fetch: app.fetch, port })

console.log(`skepsis on http://localhost:${port} (${diffArgs.join(' ')})`)
