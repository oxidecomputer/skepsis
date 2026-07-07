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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiffArgs } from '../shared/types.ts'
import { diffCommand } from './diff.ts'
import { isolateVcsConfig, requireJj, run } from './testUtil.ts'

const base = { commentsEnabled: true, files: [], endpoints: null }

const home = await isolateVcsConfig()
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

// End-to-end guard: with git's mnemonic prefixes turned on in the repo config,
// the exact scenario that produced "invalid git diff header diff --git c/… w/…"
// and the CodeView duplicate-id crash, the diffCommand override must still
// yield standard a//b/ headers that the client parser and extractFileHashes
// both understand.
describe('git mnemonicPrefix override (integration)', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skepsis-diff-test-'))
    await run('git', ['init', '-q'], dir)
    // The setting that breaks skepsis without the override.
    await run('git', ['config', 'diff.mnemonicPrefix', 'true'], dir)
    await writeFile(join(dir, 'f.txt'), 'hello\n')
    await writeFile(join(dir, 'g.txt'), 'other\n')
    await run('git', ['add', '.'], dir)
    await run('git', ['commit', '-qm', 'init'], dir)
    await writeFile(join(dir, 'f.txt'), 'hello\nworld\n')
    await writeFile(join(dir, 'g.txt'), 'other\nmore\n')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('produces a//b/ headers despite diff.mnemonicPrefix=true', async () => {
    const { args } = diffCommand({ vcs: 'git', args: ['HEAD'], ...base })
    // exec rejects on nonzero exit, so no explicit exit-code assertion needed
    const { stdout } = await run('git', args, dir)
    expect(stdout).toContain('diff --git a/f.txt b/f.txt')
    expect(stdout).toContain('--- a/f.txt')
    expect(stdout).toContain('+++ b/f.txt')
    // The mnemonic prefixes must be gone.
    expect(stdout).not.toContain('c/f.txt')
    expect(stdout).not.toContain('w/f.txt')
    expect(stdout).not.toContain('i/f.txt')
  })

  it('sanity: without the override, git emits the breaking c//w/ headers', async () => {
    const { stdout } = await run('git', ['diff', 'HEAD'], dir)
    expect(stdout).toContain('diff --git c/f.txt w/f.txt')
  })

  it('limits the diff to files passed after --', async () => {
    const { args } = diffCommand({ vcs: 'git', args: ['HEAD'], ...base, files: ['f.txt'] })
    const { stdout } = await run('git', args, dir)
    expect(stdout).toContain('diff --git a/f.txt b/f.txt')
    expect(stdout).not.toContain('g.txt')
  })
})

// Same guard as above for jj: a user config of diff.git.show-path-prefix=false
// blanks the a//b/ prefixes entirely, breaking the same parsers.
describe('jj show-path-prefix override (integration)', () => {
  let tmp: string
  let repo: string

  beforeAll(async () => {
    await requireJj()
    tmp = await mkdtemp(join(tmpdir(), 'skepsis-jj-test-'))
    await run('jj', ['git', 'init', 'repo'], tmp)
    repo = join(tmp, 'repo')
    // The setting that breaks skepsis without the override.
    await run('jj', ['config', 'set', '--repo', 'diff.git.show-path-prefix', 'false'], repo)
    await writeFile(join(repo, 'f.txt'), 'hello\n')
    await writeFile(join(repo, 'g.txt'), 'other\n')
  })

  afterAll(async () => {
    // tmp is undefined if beforeAll bailed on the jj check
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('produces a//b/ headers despite show-path-prefix=false', async () => {
    const { cmd, args } = diffCommand({ vcs: 'jj', args: ['-r', '@'], ...base })
    const { stdout } = await run(cmd, args, repo)
    expect(stdout).toContain('diff --git a/f.txt b/f.txt')
    expect(stdout).toContain('+++ b/f.txt')
  })

  it('sanity: without the override, jj blanks the prefixes', async () => {
    const { stdout } = await run('jj', ['diff', '-r', '@', '--git'], repo)
    expect(stdout).toContain('diff --git f.txt f.txt')
  })

  it('limits the diff to files passed after --', async () => {
    const src: DiffArgs = { vcs: 'jj', args: ['-r', '@'], ...base, files: ['f.txt'] }
    const { cmd, args } = diffCommand(src)
    const { stdout } = await run(cmd, args, repo)
    expect(stdout).toContain('diff --git a/f.txt b/f.txt')
    expect(stdout).not.toContain('g.txt')
  })
})
