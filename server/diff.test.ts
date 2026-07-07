/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiffArgs } from '../shared/types.ts'
import { diffCommand } from './diff.ts'

const base = { commentsEnabled: true, files: [], endpoints: null }

describe('diffCommand', () => {
  it('forces path prefixes on jj so a user show-path-prefix=false cannot blank names', () => {
    const src: DiffArgs = { vcs: 'jj', args: ['-r', '@'], ...base }
    const { cmd, args } = diffCommand(src)
    expect(cmd).toBe('jj')
    expect(args).toEqual([
      '--config',
      'diff.git.show-path-prefix=true',
      'diff',
      '-r',
      '@',
      '--git',
    ])
  })

  it('keeps file args after -- for git', () => {
    const src: DiffArgs = { vcs: 'git', args: ['HEAD'], ...base, files: ['a b.txt'] }
    const { args } = diffCommand(src)
    expect(args.slice(-3)).toEqual(['HEAD', '--', 'a b.txt'])
  })
})

const exec = promisify(execFile)

// Isolate from the user's real git config so only the temp repo's config applies.
function run(cmd: string, args: string[], cwd: string) {
  return exec(cmd, args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

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
    await run('git', ['config', 'user.email', 'test@example.com'], dir)
    await run('git', ['config', 'user.name', 'Test'], dir)
    // The setting that breaks skepsis without the override.
    await run('git', ['config', 'diff.mnemonicPrefix', 'true'], dir)
    await writeFile(join(dir, 'f.txt'), 'hello\n')
    await run('git', ['add', 'f.txt'], dir)
    await run('git', ['commit', '-qm', 'init'], dir)
    await writeFile(join(dir, 'f.txt'), 'hello\nworld\n')
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
})
