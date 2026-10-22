/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { rm } from 'node:fs/promises'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffArgs, DiffHashResponse, ErrorResponse } from '../shared/types.ts'
import { isolateVcsConfig } from './testUtil.ts'
import type * as DiffModule from './diff.ts'

// getDiff is mocked so a test can hold a diff open and count how many run.
const getDiff = vi.hoisted(() => vi.fn())
vi.mock('./diff.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffModule>()),
  getDiff,
}))

// See main.test.ts: HOME must be isolated before main.ts loads.
const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')
const { patchHash } = await import('./diff.ts')

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

const diffSource: DiffArgs = {
  vcs: 'git',
  args: ['HEAD'],
  commentsEnabled: false,
  files: [],
  endpoints: null,
}

const result = (patch: string) => ({ patch, fileHashes: {} })

async function serve(poll: boolean) {
  getDiff.mockResolvedValueOnce(result('startup'))
  const { port, close } = await startServer({ diffSource, cwd: process.cwd(), poll })
  return { url: `http://localhost:${port}`, close }
}

beforeEach(() => {
  getDiff.mockReset()
})

describe('patchHash', () => {
  it('is stable and follows the patch', () => {
    expect(patchHash('a')).toBe(patchHash('a'))
    expect(patchHash('a')).toMatch(/^[0-9a-f]{12}$/)
    expect(patchHash('a')).not.toBe(patchHash('b'))
  })
})

describe('/api/diff-hash', () => {
  it('shares a running diff between requests instead of starting another', async () => {
    const { url, close } = await serve(true)
    let finish!: (value: ReturnType<typeof result>) => void
    getDiff.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))

    const first = fetch(`${url}/api/diff-hash`)
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(2))
    const second = fetch(`${url}/api/diff-hash`)
    // Give the second request time to reach the server before the diff ends.
    await new Promise((resolve) => setTimeout(resolve, 50))
    finish(result('slow'))

    const hashes = await Promise.all(
      [first, second].map(
        async (res) => ((await (await res).json()) as DiffHashResponse).hash,
      ),
    )
    expect(hashes).toEqual([patchHash('slow'), patchHash('slow')])
    expect(getDiff).toHaveBeenCalledTimes(2)

    // Once it's done, the next request runs a fresh diff.
    getDiff.mockResolvedValueOnce(result('later'))
    const res = await fetch(`${url}/api/diff-hash`)
    expect(((await res.json()) as DiffHashResponse).hash).toBe(patchHash('later'))
    expect(getDiff).toHaveBeenCalledTimes(3)
    close()
  })

  it('is a 404 with --no-poll', async () => {
    const { url, close } = await serve(false)
    const res = await fetch(`${url}/api/diff-hash`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/no-poll/)
    expect(getDiff).toHaveBeenCalledTimes(1)
    close()
  })
})
