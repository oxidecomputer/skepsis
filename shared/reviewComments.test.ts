/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import {
  BARE_REVIEW_CLOSE_PATTERN,
  BARE_REVIEW_OPEN_PATTERN,
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

  it('does not match a bare tag line', () => {
    expect(REVIEW_OPEN_PATTERN.test('<review>')).toBe(false)
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

  it('does not match a bare tag line', () => {
    expect(REVIEW_CLOSE_PATTERN.test('</review>')).toBe(false)
  })
})

describe('bare review patterns', () => {
  it.each(['<review>', '  <review>'])('open matches %j', (line) => {
    expect(BARE_REVIEW_OPEN_PATTERN.test(line)).toBe(true)
  })

  it('close matches a bare close tag', () => {
    expect(BARE_REVIEW_CLOSE_PATTERN.test('</review>')).toBe(true)
  })

  it('does not match commented tags', () => {
    expect(BARE_REVIEW_OPEN_PATTERN.test('# <review>')).toBe(false)
    expect(BARE_REVIEW_OPEN_PATTERN.test('<!-- <review> -->')).toBe(false)
  })
})

describe('reviewTagRegex', () => {
  it('matches the emitted block-comment forms', () => {
    expect(reviewTagRegex(BLOCK_COMMENT, '<review>').test('/* <review> */')).toBe(true)
    expect(reviewTagRegex(XML_COMMENT, '</review>').test('<!-- </review> -->')).toBe(true)
  })
})
