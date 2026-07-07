/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DiffArgs } from '../shared/types.ts'
import { getDiff, validateDiffArgs } from './diff.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { insertComment, removeComment } from './comment.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentRequestSchema,
  commentDeleteSchema,
  fileContentsQuerySchema,
} from '../shared/types.ts'
import type {
  DiffResponse,
  FileContentsResponse,
  OkResponse,
  ErrorResponse,
} from '../shared/types.ts'

export async function startServer(opts: {
  diffSource: DiffArgs
  port?: number
  hostname?: string
  cwd: string
}): Promise<number> {
  const { diffSource, port = 0, hostname = 'localhost', cwd } = opts
  await validateDiffArgs(diffSource)

  const app = new Hono()

  app.get('/api/diff', async (c) => {
    const { patch, fileHashes } = await getDiff(diffSource)
    const viewed = await loadViewed(cwd, fileHashes)
    const commentSyntaxes = diffSource.commentsEnabled
      ? await getCommentSyntaxes(cwd, Object.keys(fileHashes))
      : {}
    return c.json({
      patch,
      revset: displayCommand(diffSource),
      vcs: diffSource.vcs,
      commentsEnabled: diffSource.commentsEnabled,
      expandable: diffSource.endpoints !== null,
      fileHashes,
      viewed,
      commentSyntaxes,
    } satisfies DiffResponse)
  })

  app.get('/api/file-contents', zValidator('query', fileContentsQuerySchema), async (c) => {
    const { path, oldPath } = c.req.valid('query')
    const contents = await getFileContents(diffSource, cwd, path, oldPath)
    return c.json(contents satisfies FileContentsResponse)
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

  app.delete('/api/viewed-all', zValidator('json', viewedDeleteAllSchema), async (c) => {
    const { files } = c.req.valid('json')
    await unmarkViewedAll(cwd, files)
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

  // Keep this path valid from source (`server/`) and from the published bundle
  // (`dist/cli.js`): both are one directory below the package root.
  const distDir = join(import.meta.dirname, '..', 'dist', 'web')

  // @hono/node-server resolves `root` relative to cwd. On Windows, this cannot
  // cross drive letters; installed-package use is expected on Unix-like hosts.
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
    serve({ fetch: app.fetch, port, hostname }, (info) => {
      const assignedPort = typeof info === 'string' ? port : info.port
      console.info(
        `skepsis on http://${hostname}:${assignedPort} (${displayCommand(diffSource)})`,
      )
      resolve(assignedPort)
    })
  })
}
