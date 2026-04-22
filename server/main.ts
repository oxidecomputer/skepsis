import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DiffArgs } from '../shared/types.ts'
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

export async function startServer(opts: {
  diffSource: DiffArgs
  port?: number
  cwd: string
}): Promise<number> {
  const { diffSource, port = 0, cwd } = opts
  await validateDiffArgs(diffSource)

  const app = new Hono()

  app.get('/api/diff', async (c) => {
    const { patch, fileHashes } = await getDiff(diffSource)
    const viewed = await loadViewed(cwd, fileHashes)
    const fileSuffix =
      diffSource.files.length > 0 ? ` -- ${diffSource.files.join(' ')}` : ''
    return c.json({
      patch,
      revset:
        diffSource.vcs === 'jj'
          ? `jj diff ${diffSource.args.join(' ')}${fileSuffix}`
          : `git diff ${diffSource.args.join(' ')}${fileSuffix}`,
      vcs: diffSource.vcs,
      commentsEnabled: diffSource.commentsEnabled,
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

  return new Promise((resolve) => {
    serve({ fetch: app.fetch, port }, (info) => {
      const assignedPort = typeof info === 'string' ? port : info.port
      console.info(
        `skepsis on http://localhost:${assignedPort} (${diffSource.vcs}: ${diffSource.args.join(' ')}${
          diffSource.files.length > 0 ? ` -- ${diffSource.files.join(' ')}` : ''
        })`,
      )
      resolve(assignedPort)
    })
  })
}
