/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import {
  BLOCK_COMMENT,
  REVIEW_CLOSE_PATTERN,
  REVIEW_OPEN_PATTERN,
  XML_COMMENT,
  reviewTagRegex,
} from './reviewComments.ts'

describe('REVIEW_OPEN_PATTERN', () => {
  it.each([
    '# <review>',
    '// <review>',
    '-- <review>',
    '/* <review> */',
    '<!-- <review> -->',
    '% <review>',
    '; <review>',
    '" <review>',
  ])('matches %j', (line) => {
    expect(REVIEW_OPEN_PATTERN.test(line)).toBe(true)
  })

  it('tolerates omitted block suffixes', () => {
    expect(REVIEW_OPEN_PATTERN.test('/* <review>')).toBe(true)
    expect(REVIEW_OPEN_PATTERN.test('<!-- <review>')).toBe(true)
  })
})

describe('REVIEW_CLOSE_PATTERN', () => {
  it.each([
    '# </review>',
    '// </review>',
    '-- </review>',
    '/* </review> */',
    '<!-- </review> -->',
    '% </review>',
    '; </review>',
    '" </review>',
  ])('matches %j', (line) => {
    expect(REVIEW_CLOSE_PATTERN.test(line)).toBe(true)
  })
})

describe('reviewTagRegex', () => {
  it('matches the emitted block-comment forms', () => {
    expect(reviewTagRegex(BLOCK_COMMENT, '<review>').test('/* <review> */')).toBe(true)
    expect(reviewTagRegex(XML_COMMENT, '</review>').test('<!-- </review> -->')).toBe(true)
  })
})
