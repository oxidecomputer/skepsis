/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * The library entry: serve the review page for a diff from another Node
 * server, under a prefix of its choosing. See "Embedding" in the README.
 */

import { realpathSync } from 'node:fs'
import { buildApp } from './server/app.ts'
import type { App } from './server/app.ts'
import { buildDiffSource, detectVcs, repoRoot } from './server/diffSource.ts'
import { callSend } from './server/send.ts'
import type { SendFunction, SendPayload } from './server/send.ts'

export type { App, SendFunction, SendPayload }

export interface AppOptions {
  /** The root of a jj workspace or git worktree, as an absolute path. jj or
   *  git runs here, and comments are written to files under it */
  cwd: string
  /** Default: jj when `cwd` is in a jj repository, else git */
  vcs?: 'jj' | 'git'
  /** The diff to show, as the CLI's -r takes it. With none of `revisions`,
   *  `from`, and `to`, the diff is the CLI's default */
  revisions?: string
  /** The CLI's -f */
  from?: string
  /** The CLI's -t */
  to?: string
  /** The CLI's --interdiff (jj only) */
  interdiff?: boolean
  /** Limit the diff to these paths, relative to `cwd` */
  files?: string[]
  /** Called with each comment the page sends. A throw or rejection fails the
   *  send with the error's message. When it is unset or null, the page has
   *  no Send button */
  send?: SendFunction | null
  /** How long skepsis waits for `send`. Default 10 s */
  sendTimeoutMs?: number
  /** Default true: API requests need `token`, and /api/send needs a loopback
   *  Host and a matching Origin. False when the host application checks
   *  requests before they get here */
  guard?: boolean
  /** Have the page check for changes to the diff while it's open. Default
   *  true */
  poll?: boolean
  /** Tab width in columns. Default 2 */
  tabSize?: number
}

/** The page and its API for one diff. Rejects if `cwd` isn't a repository's
 *  root, on a combination of revisions the CLI refuses, or if the diff
 *  command fails, which it runs once to find out */
export async function createApp(opts: AppOptions): Promise<App> {
  const { cwd, send, sendTimeoutMs, guard, poll, tabSize, ...flags } = opts
  const vcs = opts.vcs ?? detectVcs(cwd)
  // Diff paths are relative to the root but files are read and written
  // relative to cwd, so anywhere below the root the two disagree
  const root = repoRoot(cwd, vcs)
  if (realpathSync(root) !== realpathSync(cwd)) {
    throw new Error(`cwd must be the root of the ${vcs} repository (${root}), not ${cwd}`)
  }
  return buildApp({
    diffSource: buildDiffSource({ ...flags, cwd, vcs }),
    cwd,
    guard,
    poll,
    tabSize,
    send: send && ((payload) => callSend(send, payload, sendTimeoutMs)),
  })
}
