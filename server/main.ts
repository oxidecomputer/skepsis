import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { getDiff, resolveSessionKey } from './diff.ts'
import { loadViewed, markViewed, unmarkViewed } from './viewed.ts'
import { insertComment, removeComment } from './comment.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  commentRequestSchema,
  commentDeleteSchema,
} from '../shared/types.ts'
import type { DiffResponse, OkResponse, ErrorResponse } from '../shared/types.ts'

const revset = process.argv[2] || '@'
const port = Number(process.env['PORT']) || 3742
const cwd = process.cwd()
const sessionKey = await resolveSessionKey(revset)

const app = new Hono()

app.get('/api/diff', async (c) => {
  const { patch, fileHashes } = await getDiff(revset)
  const viewed = await loadViewed(cwd, sessionKey)
  return c.json({ patch, revset, fileHashes, viewed } satisfies DiffResponse)
})

app.post('/api/viewed', zValidator('json', viewedRequestSchema), async (c) => {
  const { file, hash } = c.req.valid('json')
  await markViewed(cwd, sessionKey, file, hash)
  return c.json({ ok: true } satisfies OkResponse)
})

app.delete('/api/viewed', zValidator('json', viewedDeleteSchema), async (c) => {
  const { file } = c.req.valid('json')
  await unmarkViewed(cwd, sessionKey, file)
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

app.onError((err, c) => {
  return c.json({ error: err.message } satisfies ErrorResponse, 500)
})

export default {
  port,
  fetch: app.fetch,
}

console.log(`local-review API on http://localhost:${port} (revset: ${revset})`)
