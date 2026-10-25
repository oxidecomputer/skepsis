/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiffArgs } from '../shared/types.ts'
import { getFileContents } from './fileContents.ts'
import { insertComment } from './comment.ts'
import { exec, isolateVcsConfig } from './testUtil.ts'

const home = await isolateVcsConfig()
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

// A regular file replaced by a symlink to another file is a git
// typechange. It used to crash the client with a CodeView duplicate id
// error. The server also followed the link when reading working copy
// contents, which showed the target file's text instead of the link
// target, and when inserting comments, which edited the target file.
describe('symlinks', () => {
  let dir: string
  let origCwd: string

  const src: DiffArgs = {
    vcs: 'git',
    args: ['HEAD'],
    commentsEnabled: true,
    files: [],
    endpoints: { left: 'HEAD', right: 'workingCopy' },
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skepsis-symlink-test-'))
    const run = (cmd: string, args: string[]) => exec(cmd, args, { cwd: dir })
    await run('git', ['init', '-q'])
    await writeFile(join(dir, 'target.txt'), 'target content\n')
    await writeFile(join(dir, 'real.txt'), 'hello\n')
    await run('git', ['add', '.'])
    await run('git', ['commit', '-qm', 'init'])
    // Turn the regular file into a symlink to another tracked file.
    await unlink(join(dir, 'real.txt'))
    await symlink('target.txt', join(dir, 'real.txt'))

    // getFileContents shells out to git in the process cwd.
    origCwd = process.cwd()
    process.chdir(dir)
  })

  afterAll(async () => {
    if (origCwd) process.chdir(origCwd)
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('serves the link target as the new contents, not the followed file', async () => {
    const contents = await getFileContents(src, dir, 'real.txt')
    expect(contents.oldContents).toBe('hello\n')
    expect(contents.newContents).toBe('target.txt')
  })

  it('refuses to insert comments through a symlink', async () => {
    await expect(insertComment(dir, 'real.txt', 1, 'hello', 'needs work')).rejects.toThrow(
      /symlink/,
    )
    // The link target must be untouched.
    expect(await readFile(join(dir, 'target.txt'), 'utf-8')).toBe('target content\n')
  })
})
