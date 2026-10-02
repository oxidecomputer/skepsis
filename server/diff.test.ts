/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiffArgs } from '../shared/types.ts'
import { diffCommand, normalizeJjRenames } from './diff.ts'
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

// jj's git-format diff omits the "similarity index" line, and @pierre/diffs
// only treats a git diff block as a rename when it has one. Without it, a
// rename parses as a plain change to the new path and loses the old name.
describe('jj rename headers (integration)', () => {
  let tmp: string
  let repo: string

  beforeAll(async () => {
    await requireJj()
    tmp = await mkdtemp(join(tmpdir(), 'skepsis-jj-rename-test-'))
    await run('jj', ['git', 'init', 'repo'], tmp)
    repo = join(tmp, 'repo')
    await writeFile(join(repo, 'pure.txt'), 'same\n')
    await writeFile(join(repo, 'changed.txt'), 'a\nb\nc\nd\ne\n')
    await run('jj', ['commit', '-m', 'base'], repo)
    await rename(join(repo, 'pure.txt'), join(repo, 'pure2.txt'))
    await rename(join(repo, 'changed.txt'), join(repo, 'changed2.txt'))
    await writeFile(join(repo, 'changed2.txt'), 'a\nb\nC\nd\ne\n')
  })

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  async function parsedFiles() {
    const { cmd, args } = diffCommand({ vcs: 'jj', args: ['-r', '@'], ...base })
    const { stdout } = await run(cmd, args, repo)
    return parsePatchFiles(normalizeJjRenames(stdout)).flatMap((p) => p.files)
  }

  it('parses pure and changed renames with their old names', async () => {
    const files = await parsedFiles()
    expect(files.map((f) => [f.type, f.prevName, f.name])).toEqual([
      ['rename-changed', 'changed.txt', 'changed2.txt'],
      ['rename-pure', 'pure.txt', 'pure2.txt'],
    ])
  })

  it('sanity: without normalizing, renames parse as plain changes', async () => {
    const { cmd, args } = diffCommand({ vcs: 'jj', args: ['-r', '@'], ...base })
    const { stdout } = await run(cmd, args, repo)
    const files = parsePatchFiles(stdout).flatMap((p) => p.files)
    expect(files.map((f) => [f.type, f.prevName])).toEqual([
      ['change', undefined],
      ['change', undefined],
    ])
  })
})
