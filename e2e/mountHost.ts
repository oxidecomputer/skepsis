/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * A stand-in for an application that mounts skepsis: it serves the diff of
 * the repo in its cwd under the prefix given as its argument and handles Send
 * with a function that appends to .git/sent.jsonl. With `guard` as a second
 * argument it leaves skepsis's guard on, and the URL it prints has the token.
 * Without, it turns the guard off, as a host that checks requests itself
 * does. It checks nothing, so it listens on loopback only. Anything outside
 * the prefix is a 404, logged as `404 <path>`. Prints `host on <url>` once
 * listening.
 *
 * skepsis is imported by package name, which resolves to the build in dist/,
 * so this also checks the package's export and the bundled library's path to
 * the page's files.
 */

import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from '@oxide/skepsis'

const PREFIX = process.argv[2]!
const GUARD = process.argv[3] === 'guard'
const HOSTNAME = '127.0.0.1'

const cwd = process.cwd()
const app = await createApp({
  cwd,
  vcs: 'git',
  guard: GUARD,
  send: (payload) =>
    appendFile(join(cwd, '.git', 'sent.jsonl'), JSON.stringify(payload) + '\n'),
})

serve(
  {
    port: 0,
    hostname: HOSTNAME,
    fetch: (req) => {
      const url = new URL(req.url)
      if (!url.pathname.startsWith(`${PREFIX}/`)) {
        console.info(`404 ${url.pathname}`)
        return new Response('not found', { status: 404 })
      }
      url.pathname = url.pathname.slice(PREFIX.length)
      return app.fetch(new Request(url, req))
    },
  },
  (info) => {
    const fragment = app.token ? `#token=${app.token}` : ''
    console.info(`host on http://${HOSTNAME}:${info.port}${PREFIX}/${fragment}`)
  },
)
