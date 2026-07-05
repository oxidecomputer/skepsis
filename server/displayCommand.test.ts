/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import type { DiffArgs } from '../shared/types.ts'
import { displayCommand } from './displayCommand.ts'

const base = { commentsEnabled: true, files: [], endpoints: null }

describe('displayCommand', () => {
  it('leaves plain args unquoted', () => {
    const src: DiffArgs = { vcs: 'git', args: ['--merge-base', 'origin/main'], ...base }
    expect(displayCommand(src)).toBe('git diff --merge-base origin/main')
  })

  it('quotes args with shell metacharacters so the command is runnable', () => {
    const src: DiffArgs = {
      vcs: 'jj',
      args: ['--from', 'fork_point(trunk() | @)'],
      ...base,
    }
    expect(displayCommand(src)).toBe("jj diff --from 'fork_point(trunk() | @)'")
  })

  it('escapes single quotes inside quoted args', () => {
    const src: DiffArgs = { vcs: 'git', args: ["it's"], ...base }
    expect(displayCommand(src)).toBe(String.raw`git diff 'it'\''s'`)
  })

  it('prefers displayArgs over args when present', () => {
    const src: DiffArgs = {
      vcs: 'git',
      args: ['0123456789abcdef0123456789abcdef01234567'],
      displayArgs: ['--merge-base', 'origin/main'],
      ...base,
    }
    expect(displayCommand(src)).toBe('git diff --merge-base origin/main')
  })

  it('quotes file paths after --', () => {
    const src: DiffArgs = {
      vcs: 'git',
      args: ['main'],
      ...base,
      files: ['src/app.ts', 'my file.txt'],
    }
    expect(displayCommand(src)).toBe("git diff main -- src/app.ts 'my file.txt'")
  })
})
