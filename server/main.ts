import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { join } from 'path'
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
app.get('*', async (c) => {
  const path = new URL(c.req.url).pathname
  const file = Bun.file(join(distDir, path))
  if (await file.exists()) return new Response(file)
  // SPA fallback
  return new Response(Bun.file(join(distDir, 'index.html')))
})

app.onError((err, c) => {
  return c.json({ error: err.message } satisfies ErrorResponse, 500)
})

export default {
  port,
  fetch: app.fetch,
}

console.log(`local-review API on http://localhost:${port} (${diffArgs.join(' ')})`)
