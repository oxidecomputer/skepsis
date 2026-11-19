/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { DiffArgs, DiffResponse, FileContentsResponse } from '../shared/types.ts'
import type { App } from './app.ts'
import { isolateVcsConfig, run } from './testUtil.ts'

// See main.test.ts: HOME must be isolated before app.ts loads.
const home = await isolateVcsConfig()
const { buildApp } = await import('./app.ts')

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'skepsis-app-test-'))
})

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

/** A git repo with f.txt changed from `before` to `after` in the working tree */
async function repo(name: string, before: string, after: string): Promise<string> {
  const dir = join(tmp, name)
  await run('git', ['init', '-q', dir], tmp)
  await writeFile(join(dir, 'f.txt'), before)
  await run('git', ['add', '.'], dir)
  await run('git', ['commit', '-qm', 'init'], dir)
  await writeFile(join(dir, 'f.txt'), after)
  return dir
}

const diffSource: DiffArgs = {
  vcs: 'git',
  args: ['HEAD'],
  toWorkingCopy: true,
  files: [],
  endpoints: { left: 'HEAD', right: 'workingCopy' },
}

/** A request as a host passes it on, with no token and its prefix removed */
async function json(app: App, path: string): Promise<unknown> {
  return (await app.fetch(new Request(`https://example.ts.net${path}`))).json()
}

it('serves several diffs in one process, each from its own directory, guard off', async () => {
  const dirs = [await repo('a', 'a1\n', 'a2\n'), await repo('b', 'b1\n', 'b2\n')]
  const apps = await Promise.all(
    dirs.map((cwd) => buildApp({ cwd, diffSource, guard: false }, () => '')),
  )
  const diffs = (await Promise.all(
    apps.map((app) => json(app, '/api/diff')),
  )) as DiffResponse[]
  expect(apps.map((app) => app.token)).toEqual([null, null])
  expect(diffs.map((d) => d.repo)).toEqual(['a', 'b'])
  expect(diffs[0]!.patch).toContain('-a1\n+a2')
  expect(diffs[1]!.patch).toContain('-b1\n+b2')
  const contents = (await Promise.all(
    apps.map((app) => json(app, '/api/file-contents?path=f.txt')),
  )) as FileContentsResponse[]
  expect(contents).toEqual([
    { oldContents: 'a1\n', newContents: 'a2\n' },
    { oldContents: 'b1\n', newContents: 'b2\n' },
  ])
})
