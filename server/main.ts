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
import { basename, join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DiffArgs } from '../shared/types.ts'
import { getDiff, patchHash } from './diff.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { insertComment, removeComment } from './comment.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import { newToken, sendGate, tokenMatches } from './gate.ts'
import { buildPayload, runSend } from './send.ts'
import type { SendResult } from './send.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentRequestSchema,
  commentDeleteSchema,
  sendRequestSchema,
  fileContentsQuerySchema,
  themeRequestSchema,
  TOKEN_HEADER,
} from '../shared/types.ts'
import type {
  DiffHashResponse,
  DiffResponse,
  FileContentsResponse,
  OkResponse,
  ErrorResponse,
  ThemeResponse,
} from '../shared/types.ts'

export async function startServer(opts: {
  diffSource: DiffArgs
  port?: number
  hostname?: string
  cwd: string
  /** Serve /api/diff-hash for the page's change polling. Default true. */
  poll?: boolean
  /** The --send command. Unset, /api/send doesn't exist. */
  send?: string | null
  /** Overrides runSend's timeout, for tests */
  sendTimeoutMs?: number
}): Promise<{ port: number; token: string; close: () => void }> {
  const { diffSource, port = 0, hostname = 'localhost', cwd, poll = true, send } = opts
  // Fail fast on bad args by running the exact diff command we'll serve.
  // Result is discarded: /api/diff re-runs it per request to stay fresh.
  await getDiff(diffSource)

  const app = new Hono()
  const token = newToken()

  // Every API call must carry the token (see tokenMatches). The theme boot
  // script is the exception: a <script src> can't send a header, and all it
  // gives away is the theme.
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/theme.js' || tokenMatches(c.req.header(TOKEN_HEADER), token))
      return next()
    return c.json(
      {
        error:
          'This page has no valid token. Open the URL skepsis printed when it started.',
      } satisfies ErrorResponse,
      401,
    )
  })

  app.get('/api/diff', async (c) => {
    const { patch, fileHashes } = await getDiff(diffSource)
    const viewed = await loadViewed(cwd, fileHashes)
    const commentSyntaxes = diffSource.commentsEnabled
      ? await getCommentSyntaxes(cwd, Object.keys(fileHashes))
      : {}
    return c.json({
      patch,
      revset: displayCommand(diffSource),
      repo: basename(cwd),
      vcs: diffSource.vcs,
      commentsEnabled: diffSource.commentsEnabled,
      expandable: diffSource.endpoints !== null,
      fileHashes,
      patchHash: patchHash(patch),
      poll,
      send: !!send,
      viewed,
      commentSyntaxes,
    } satisfies DiffResponse)
  })

  // Polled every few seconds while the page is visible. Requests that arrive
  // while a diff is running share its result rather than starting another, so
  // several tabs, or a diff slower than the interval, never pile up. /api/diff
  // doesn't share: it follows the page's own edits (a comment), and a poll
  // that started before the edit would hand back the old patch.
  let hashInFlight: Promise<string> | null = null
  app.get('/api/diff-hash', async (c) => {
    if (!poll)
      return c.json({ error: 'polling is off (--no-poll)' } satisfies ErrorResponse, 404)
    hashInFlight ??= getDiff(diffSource)
      .then(({ patch }) => patchHash(patch))
      .finally(() => {
        hashInFlight = null
      })
    return c.json({ hash: await hashInFlight } satisfies DiffHashResponse)
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
    const { file, afterLine, lineText, text } = c.req.valid('json')
    await insertComment(cwd, file, afterLine, lineText, text)
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Runs the --send command, so only the page may call it (see gate.ts).
  // Sends run one at a time in arrival order, so two quick ones can't reach
  // the far end swapped.
  let sendQueue: Promise<SendResult> = Promise.resolve({ ok: true, output: '' })
  // Known once listening; for SKEPSIS_URL.
  let serverUrl = ''
  if (send) {
    app.post(
      '/api/send',
      async (c, next) => {
        const headers = {
          host: c.req.header('host'),
          origin: c.req.header('origin'),
        }
        if (!sendGate(headers))
          return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
        await next()
      },
      zValidator('json', sendRequestSchema),
      async (c) => {
        // The blob comes from the page with the lines and excerpt, so all
        // three describe the version on screen even if the file has changed
        // since. Nothing here awaits, so sends join the queue as they arrive.
        const payload = buildPayload(diffSource, cwd, c.req.valid('json'))
        const env = { SKEPSIS_URL: serverUrl, SKEPSIS_ROOT: cwd }
        const run = () =>
          runSend(send, payload, { cwd, env, timeoutMs: opts.sendTimeoutMs })
        const result = sendQueue.then(run, run)
        sendQueue = result
        const r = await result
        if (!r.ok) return c.json({ error: r.error } satisfies ErrorResponse, 502)
        return c.json({ ok: true } satisfies OkResponse)
      },
    )
  }

  app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
    const { file, line } = c.req.valid('json')
    await removeComment(cwd, file, line)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.get('/api/theme', async (c) => {
    return c.json({ theme: await loadTheme() } satisfies ThemeResponse)
  })

  // Loaded by a render-blocking <script> in index.html (see themeBootScript).
  // no-store: a cached copy would re-apply an old preference before React
  // corrects it, flashing the wrong theme — the exact problem this solves.
  app.get('/api/theme.js', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'text/javascript')
    return c.body(themeBootScript(await loadTheme()))
  })

  app.post('/api/theme', zValidator('json', themeRequestSchema), async (c) => {
    await saveTheme(c.req.valid('json').theme)
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

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      const assignedPort = typeof info === 'string' ? port : info.port
      serverUrl = `http://${hostname}:${assignedPort}`
      console.info(
        `skepsis on ${serverUrl}/#token=${token} (${displayCommand(diffSource)})`,
      )
      resolve({ port: assignedPort, token, close: () => server.close() })
    })
    server.on('error', reject)
  })
}
