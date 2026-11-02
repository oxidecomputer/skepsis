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
import { afterAll, describe, expect, it } from 'vitest'
import { getGeneratedFiles } from './generated.ts'
import { isolateVcsConfig, run } from './testUtil.ts'

const home = await isolateVcsConfig()
const dirs: string[] = []
afterAll(async () => {
  await Promise.all([home, ...dirs].map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skepsis-generated-test-'))
  dirs.push(dir)
  return dir
}

describe('getGeneratedFiles', () => {
  it('reads linguist-generated in each form git accepts', async () => {
    const dir = await tempDir()
    await run('git', ['init', '-q'], dir)
    await writeFile(
      join(dir, '.gitattributes'),
      [
        'gen/** linguist-generated=true',
        'bare.ts linguist-generated',
        // Any value but false counts, as in Linguist.
        'one.ts linguist-generated=1',
        // An explicit opt-out beats the lockfile default.
        'Cargo.lock -linguist-generated',
        'yarn.lock linguist-generated=false',
      ].join('\n'),
    )
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', '.gitattributes'), 'local.ts linguist-generated\n')
    // Not checked in, but git still reads it.
    await writeFile(
      join(dir, '.git', 'info', 'attributes'),
      'private.ts linguist-generated\n',
    )

    const files = [
      'gen/a b.json',
      'bare.ts',
      'one.ts',
      'sub/local.ts',
      'private.ts',
      'src/main.ts',
      'Cargo.lock',
      'yarn.lock',
      'web/package-lock.json',
    ]
    expect(await getGeneratedFiles(dir, files)).toEqual([
      'gen/a b.json',
      'bare.ts',
      'one.ts',
      'sub/local.ts',
      'private.ts',
      'web/package-lock.json',
    ])
  })

  it('resolves root-relative paths when started in a subdirectory', async () => {
    const dir = await tempDir()
    await run('git', ['init', '-q'], dir)
    await writeFile(
      join(dir, '.gitattributes'),
      'sub/gen/** linguist-generated\n/Cargo.lock -linguist-generated\n',
    )
    await mkdir(join(dir, 'sub'))
    const files = ['sub/gen/a.ts', 'Cargo.lock', 'sub/main.ts']
    expect(await getGeneratedFiles(join(dir, 'sub'), files)).toEqual(['sub/gen/a.ts'])
  })

  it('falls back to lockfile names outside a git repo', async () => {
    const dir = await tempDir()
    expect(await getGeneratedFiles(dir, ['Cargo.lock', 'src/lib.rs'])).toEqual([
      'Cargo.lock',
    ])
  })
})
