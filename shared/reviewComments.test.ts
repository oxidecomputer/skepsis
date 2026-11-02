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
  reviewOpenTag,
  reviewOpenTagAttributes,
  reviewOpenTagLines,
  reviewTagRegex,
  shortQuote,
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
    '// <review covers="6 lines above">',
    '/* <review covers="2 lines above"> */',
    '<!-- <review covers="12 lines above"> -->',
    '# <review covers="2 lines above" by="someone">',
  ])('matches %j', (line) => {
    expect(REVIEW_OPEN_PATTERN.test(line)).toBe(true)
  })

  it.each(['// <reviewer>', '// <review covers>', '// <review: 6 lines above>'])(
    'does not match %j',
    (line) => {
      expect(REVIEW_OPEN_PATTERN.test(line)).toBe(false)
    },
  )

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

describe('reviewOpenTag', () => {
  it('leaves the count off a one-line comment', () => {
    expect(reviewOpenTag(1)).toBe('<review>')
  })

  it.each([1, 2, 40])('round-trips %i lines', (n) => {
    expect(reviewOpenTagLines(`  // ${reviewOpenTag(n)}`)).toBe(n)
  })

  it('reads a plain tag as the line above', () => {
    expect(reviewOpenTagLines('# <review>')).toBe(1)
  })

  it('says which words a comment is on', () => {
    expect(reviewOpenTag(1, 'some\n  "words"')).toBe('<review on="some &quot;words&quot;">')
    expect(reviewOpenTag(2, 'a > b')).toBe('<review covers="2 lines above" on="a > b">')
    expect(reviewOpenTag(1, ' \n')).toBe('<review>')
    expect(REVIEW_OPEN_PATTERN.test(`// ${reviewOpenTag(1, 'x = "a>b"')}`)).toBe(true)
    expect(reviewOpenTagLines(`# ${reviewOpenTag(3, 'a "b"')}`)).toBe(3)
  })

  it('cuts a long quote in the middle', () => {
    const quote = `${'a'.repeat(50)} ${'b'.repeat(50)}`
    const on = reviewOpenTagAttributes(`# ${reviewOpenTag(1, quote)}`)['on']!
    expect(on).toBe(`${'a'.repeat(39)} … ${'b'.repeat(38)}`)
  })

  it('cuts a long quote between code points', () => {
    expect(shortQuote(`${'😀'.repeat(10)}${'b'.repeat(10)}`, 9)).toBe('😀😀😀 … bbb')
  })

  it('reads a covers value it does not understand as the line above', () => {
    expect(reviewOpenTagLines('# <review covers="lines 2-7">')).toBe(1)
  })
})
