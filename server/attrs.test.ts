/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { mergeAttrs, parseCheckAttrOutput } from './attrs.ts'

describe('parseCheckAttrOutput', () => {
  it('returns empty object for empty input', () => {
    expect(parseCheckAttrOutput('')).toEqual({})
  })

  it('parses a generated file as an explicit set', () => {
    const out = [
      'pnpm-lock.yaml: linguist-generated: set',
      'pnpm-lock.yaml: linguist-vendored: unspecified',
      'pnpm-lock.yaml: linguist-documentation: unspecified',
      'pnpm-lock.yaml: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)).toEqual({
      'pnpm-lock.yaml': { generated: true },
    })
  })

  it('drops files where nothing was set or unset', () => {
    const out = [
      'src/foo.ts: linguist-generated: unspecified',
      'src/foo.ts: linguist-vendored: unspecified',
      'src/foo.ts: linguist-documentation: unspecified',
      'src/foo.ts: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)).toEqual({})
  })

  it('records `unset` as an explicit false', () => {
    const out = [
      'README.md: linguist-generated: unset',
      'README.md: linguist-vendored: unspecified',
      'README.md: linguist-documentation: set',
      'README.md: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)).toEqual({
      'README.md': { generated: false, documentation: true },
    })
  })

  it('parses multiple files', () => {
    const out = [
      'pnpm-lock.yaml: linguist-generated: set',
      'pnpm-lock.yaml: linguist-vendored: unspecified',
      'pnpm-lock.yaml: linguist-documentation: unspecified',
      'pnpm-lock.yaml: binary: unspecified',
      'third-party/lib.js: linguist-generated: unspecified',
      'third-party/lib.js: linguist-vendored: set',
      'third-party/lib.js: linguist-documentation: unspecified',
      'third-party/lib.js: binary: unspecified',
      'logo.png: linguist-generated: unspecified',
      'logo.png: linguist-vendored: unspecified',
      'logo.png: linguist-documentation: unspecified',
      'logo.png: binary: set',
      '',
    ].join('\n')
    const result = parseCheckAttrOutput(out)
    expect(result['pnpm-lock.yaml']?.generated).toBe(true)
    expect(result['third-party/lib.js']?.vendored).toBe(true)
    expect(result['logo.png']?.binary).toBe(true)
    expect(Object.keys(result).length).toBe(3)
  })

  it('handles paths containing colons', () => {
    // Unusual but legal — git doesn't quote these, so the parser must split
    // from the right.
    const out = [
      'weird: file: linguist-generated: set',
      'weird: file: linguist-vendored: unspecified',
      'weird: file: linguist-documentation: unspecified',
      'weird: file: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)['weird: file']?.generated).toBe(true)
  })

  it('ignores unrelated attribute lines', () => {
    const out = [
      'foo.ts: unrelated-attr: set',
      'foo.ts: linguist-generated: set',
      'foo.ts: linguist-vendored: unspecified',
      'foo.ts: linguist-documentation: unspecified',
      'foo.ts: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)).toEqual({
      'foo.ts': { generated: true },
    })
  })
})

describe('mergeAttrs', () => {
  it('returns {} for no layers', () => {
    expect(mergeAttrs([])).toEqual({})
  })

  it('returns {} when nothing ends up set', () => {
    expect(mergeAttrs([{ 'foo.ts': { generated: false } }])).toEqual({})
  })

  it('materializes a single layer to full FileAttrs', () => {
    expect(mergeAttrs([{ 'foo.ts': { generated: true } }])).toEqual({
      'foo.ts': {
        generated: true,
        vendored: false,
        documentation: false,
        binary: false,
      },
    })
  })

  it('lets a higher-priority layer override a lower one (per attribute)', () => {
    // check-attr says linguist-generated: unset, even though path rules say
    // it's generated. Expect the explicit unset to win.
    const checkAttr = { 'weird.js': { generated: false } }
    const pathRules = { 'weird.js': { generated: true } }
    expect(mergeAttrs([checkAttr, pathRules])).toEqual({})
  })

  it('falls through to the next layer when the first is silent on an attr', () => {
    // check-attr sets linguist-documentation, says nothing about generated.
    // path rules say the file is generated. Expect both to apply.
    const checkAttr = { 'foo.md': { documentation: true } }
    const pathRules = { 'foo.md': { generated: true } }
    expect(mergeAttrs([checkAttr, pathRules])).toEqual({
      'foo.md': {
        generated: true,
        vendored: false,
        documentation: true,
        binary: false,
      },
    })
  })

  it('unions paths across layers', () => {
    const a = { 'a.ts': { generated: true } }
    const b = { 'b.ts': { vendored: true } }
    const merged = mergeAttrs([a, b])
    expect(merged['a.ts']?.generated).toBe(true)
    expect(merged['b.ts']?.vendored).toBe(true)
  })
})
