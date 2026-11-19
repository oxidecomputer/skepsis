/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { buildDiffSource } from './diffSource.ts'

describe('--interdiff checks', () => {
  it('needs jj', () => {
    expect(() =>
      buildDiffSource({ vcs: 'git', interdiff: true, from: 'a', to: 'b' }),
    ).toThrow('--interdiff needs jj')
  })

  it("can't be combined with -r", () => {
    expect(() => buildDiffSource({ vcs: 'jj', interdiff: true, revisions: '@' })).toThrow(
      "--interdiff can't be combined with -r",
    )
  })

  it('needs -f or -t', () => {
    expect(() => buildDiffSource({ vcs: 'jj', interdiff: true })).toThrow(
      '--interdiff needs -f, -t, or both',
    )
  })

  it('has no endpoints', () => {
    expect(buildDiffSource({ vcs: 'jj', interdiff: true, from: 'a' })).toMatchObject({
      args: ['--from', 'a'],
      endpoints: null,
      toWorkingCopy: true,
    })
  })
})
