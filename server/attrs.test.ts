/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { parseCheckAttrOutput } from './attrs.ts'

describe('parseCheckAttrOutput', () => {
  it('returns empty object for empty input', () => {
    expect(parseCheckAttrOutput('')).toEqual({})
  })

  it('parses a single generated file', () => {
    const out = [
      'pnpm-lock.yaml: linguist-generated: set',
      'pnpm-lock.yaml: linguist-vendored: unspecified',
      'pnpm-lock.yaml: linguist-documentation: unspecified',
      'pnpm-lock.yaml: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)).toEqual({
      'pnpm-lock.yaml': {
        generated: true,
        vendored: false,
        documentation: false,
        binary: false,
      },
    })
  })

  it('drops files where nothing was set', () => {
    const out = [
      'src/foo.ts: linguist-generated: unspecified',
      'src/foo.ts: linguist-vendored: unspecified',
      'src/foo.ts: linguist-documentation: unspecified',
      'src/foo.ts: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)).toEqual({})
  })

  it('treats `unset` as false', () => {
    const out = [
      'README.md: linguist-generated: unset',
      'README.md: linguist-vendored: unspecified',
      'README.md: linguist-documentation: set',
      'README.md: binary: unspecified',
      '',
    ].join('\n')
    expect(parseCheckAttrOutput(out)).toEqual({
      'README.md': {
        generated: false,
        vendored: false,
        documentation: true,
        binary: false,
      },
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
      'foo.ts': {
        generated: true,
        vendored: false,
        documentation: false,
        binary: false,
      },
    })
  })
})
