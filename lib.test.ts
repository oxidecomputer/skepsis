/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { TOKEN_HEADER } from './shared/types.ts'
import type { DiffResponse, ErrorResponse, FileContentsResponse } from './shared/types.ts'
import type { App, SendPayload } from './lib.ts'
import { isolateVcsConfig, run } from './server/testUtil.ts'

// See server/main.test.ts: HOME must be isolated before the server loads.
const home = await isolateVcsConfig()
const { createApp } = await import('./lib.ts')

let tmp: string
/** A git repo with sub/f.txt changed from "before" to "after" in the working tree */
let repo: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'skepsis-lib-test-'))
  repo = join(tmp, 'repo')
  await run('git', ['init', '-q', repo], tmp)
  await mkdir(join(repo, 'sub'))
  await writeFile(join(repo, 'sub', 'f.txt'), 'before\n')
  await run('git', ['add', '.'], repo)
  await run('git', ['commit', '-qm', 'init'], repo)
  await writeFile(join(repo, 'sub', 'f.txt'), 'after\n')
})

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

const get = (app: App, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://example.ts.net${path}`, { headers }))

it('serves the diff the revision options select, behind the token', async () => {
  const app = await createApp({ cwd: repo, revisions: 'HEAD' })
  expect((await get(app, '/api/diff')).status).toBe(401)

  const headers = { [TOKEN_HEADER]: app.token! }
  const diff = (await (await get(app, '/api/diff', headers)).json()) as DiffResponse
  expect(diff.vcs).toBe('git')
  expect(diff.revset).toBe('git diff HEAD')
  expect(diff.patch).toContain('-before\n+after')
  expect(diff.send).toBe(false)
  const contents = await get(app, '/api/file-contents?path=sub/f.txt', headers)
  expect((await contents.json()) as FileContentsResponse).toEqual({
    oldContents: 'before\n',
    newContents: 'after\n',
  })
})

it('rejects a cwd below the repository root', async () => {
  await expect(createApp({ cwd: join(repo, 'sub'), revisions: 'HEAD' })).rejects.toThrow(
    /cwd must be the root of the git repository/,
  )
})

it('rejects what the CLI refuses', async () => {
  await expect(createApp({ cwd: repo, interdiff: true, from: 'HEAD' })).rejects.toThrow(
    '--interdiff needs jj',
  )
  await expect(createApp({ cwd: tmp })).rejects.toThrow('Not in a jj or git repository')
})

it('calls send with the payload, and reports a throw as the error', async () => {
  const got: SendPayload[] = []
  const app = await createApp({
    cwd: repo,
    revisions: 'HEAD',
    guard: false,
    send: (payload) => {
      if (payload.text === 'fail') throw new Error('no agent')
      got.push(payload)
    },
  })
  expect(app.token).toBeNull()
  const send = (text: string) =>
    app.fetch(
      new Request('https://example.ts.net/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: null,
          side: null,
          lines: null,
          columns: null,
          code: null,
          blob: null,
          text,
        }),
      }),
    )
  expect((await send('hello')).status).toBe(200)
  expect(got).toMatchObject([{ root: repo, text: 'hello', prompt: expect.any(String) }])
  const failed = await send('fail')
  expect(failed.status).toBe(502)
  expect(((await failed.json()) as ErrorResponse).error).toBe('no agent')
})
