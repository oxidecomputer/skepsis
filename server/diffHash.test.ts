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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffArgs, DiffHashResponse, ErrorResponse } from '../shared/types.ts'
import { TOKEN_HEADER } from '../shared/types.ts'
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

async function serve(poll: boolean, cwd = process.cwd()) {
  getDiff.mockResolvedValueOnce(result('startup'))
  const { port, token, close } = await startServer({ diffSource, cwd, poll })
  const url = `http://localhost:${port}`
  const diffHash = () =>
    fetch(`${url}/api/diff-hash`, { headers: { [TOKEN_HEADER]: token } })
  const comment = (body: unknown) =>
    fetch(`${url}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify(body),
    })
  return { diffHash, comment, close }
}

/** A diff that runs until `finish` is called. */
function heldDiff() {
  let finish!: (value: ReturnType<typeof result>) => void
  getDiff.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
  return (patch: string) => finish(result(patch))
}

const hashOf = async (res: Promise<Response>) =>
  ((await (await res).json()) as DiffHashResponse).hash

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
    const { diffHash, close } = await serve(true)
    let finish!: (value: ReturnType<typeof result>) => void
    getDiff.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))

    const first = diffHash()
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(2))
    const second = diffHash()
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
    const res = await diffHash()
    expect(((await res.json()) as DiffHashResponse).hash).toBe(patchHash('later'))
    expect(getDiff).toHaveBeenCalledTimes(3)
    close()
  })

  it("doesn't share a diff that started before a comment", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skepsis-diff-hash-'))
    await writeFile(join(dir, 'a.ts'), 'x\n')
    const { diffHash, comment, close } = await serve(true, dir)
    const finishBefore = heldDiff()
    const before = diffHash()
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(2))

    const res = await comment({ file: 'a.ts', afterLine: 1, lineText: 'x', text: 'hi' })
    expect(res.status).toBe(200)
    const finishAfter = heldDiff()
    const after = diffHash()
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(3))

    // The old diff finishing doesn't drop the new one, which later polls share.
    finishBefore('before')
    expect(await hashOf(before)).toBe(patchHash('before'))
    const later = diffHash()
    await new Promise((resolve) => setTimeout(resolve, 50))
    finishAfter('after')
    expect(await hashOf(after)).toBe(patchHash('after'))
    expect(await hashOf(later)).toBe(patchHash('after'))
    expect(getDiff).toHaveBeenCalledTimes(3)
    close()
    await rm(dir, { recursive: true, force: true })
  })

  it('is a 404 with --no-poll', async () => {
    const { diffHash, close } = await serve(false)
    const res = await diffHash()
    expect(res.status).toBe(404)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/no-poll/)
    expect(getDiff).toHaveBeenCalledTimes(1)
    close()
  })
})
