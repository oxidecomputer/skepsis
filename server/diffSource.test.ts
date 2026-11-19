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
import { buildDiffSource, detectVcs } from './diffSource.ts'
import { isolateVcsConfig, requireJj, run } from './testUtil.ts'

const home = await isolateVcsConfig()
let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'skepsis-diffsource-test-'))
})

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('--interdiff checks', () => {
  const cwd = '/nonexistent'
  it('needs jj', () => {
    expect(() =>
      buildDiffSource({ cwd, vcs: 'git', interdiff: true, from: 'a', to: 'b' }),
    ).toThrow('--interdiff needs jj')
  })

  it("can't be combined with -r", () => {
    expect(() =>
      buildDiffSource({ cwd, vcs: 'jj', interdiff: true, revisions: '@' }),
    ).toThrow("--interdiff can't be combined with -r")
  })

  it('needs -f or -t', () => {
    expect(() => buildDiffSource({ cwd, vcs: 'jj', interdiff: true })).toThrow(
      '--interdiff needs -f, -t, or both',
    )
  })

  it('has no endpoints', () => {
    expect(buildDiffSource({ cwd, vcs: 'jj', interdiff: true, from: 'a' })).toMatchObject({
      args: ['--from', 'a'],
      endpoints: null,
      toWorkingCopy: true,
    })
  })
})

// None of these touch the process's cwd, which is the skepsis checkout.
describe('in a repo other than the process cwd', () => {
  it('detects jj and git', async () => {
    await requireJj()
    const jjRepo = join(tmp, 'jj')
    await run('jj', ['git', 'init', jjRepo], tmp)
    const gitRepo = join(tmp, 'git')
    await run('git', ['init', '-q', gitRepo], tmp)
    expect(detectVcs(jjRepo)).toBe('jj')
    expect(detectVcs(gitRepo)).toBe('git')
    expect(() => detectVcs(tmp)).toThrow('Not in a jj or git repository')
  })

  it("resolves the default git diff's base there", async () => {
    const repo = join(tmp, 'git-base')
    await run('git', ['init', '-q', '-b', 'main', repo], tmp)
    await writeFile(join(repo, 'f.txt'), 'a\n')
    await run('git', ['add', '.'], repo)
    await run('git', ['commit', '-qm', 'base'], repo)
    const base = (await run('git', ['rev-parse', 'HEAD'], repo)).stdout.trim()
    await run('git', ['checkout', '-qb', 'feature'], repo)
    await writeFile(join(repo, 'f.txt'), 'b\n')
    await run('git', ['commit', '-qam', 'feature'], repo)

    expect(buildDiffSource({ cwd: repo, vcs: 'git' })).toEqual({
      vcs: 'git',
      args: [base],
      displayArgs: ['--merge-base', 'main'],
      toWorkingCopy: true,
      files: [],
      endpoints: { left: base, right: 'workingCopy' },
    })
  })

  it("passes on git's error outside a repo", () => {
    expect(() => buildDiffSource({ cwd: tmp, vcs: 'git' })).toThrow(/not a git repository/)
  })
})
