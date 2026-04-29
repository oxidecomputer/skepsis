/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { parseCatFileBatch } from './contentReader.ts'

function concat(...parts: (string | Buffer)[]): Buffer {
  return Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf-8') : p)),
  )
}

describe('parseCatFileBatch', () => {
  it('returns empty map for empty input', () => {
    expect(parseCatFileBatch(Buffer.alloc(0))).toEqual(new Map())
  })

  it('parses a single blob', () => {
    const content = 'hello world\n'
    const size = Buffer.byteLength(content, 'utf-8')
    const buf = concat(`aabbccdd blob ${size}\n`, content, '\n')
    const result = parseCatFileBatch(buf)
    expect(result.get('aabbccdd')).toBe(content)
    expect(result.size).toBe(1)
  })

  it('skips missing objects', () => {
    const content = 'hi\n'
    const size = Buffer.byteLength(content, 'utf-8')
    const buf = concat('deadbeef missing\n', `cafebabe blob ${size}\n`, content, '\n')
    const result = parseCatFileBatch(buf)
    expect(result.size).toBe(1)
    expect(result.get('cafebabe')).toBe(content)
  })

  it('parses multiple blobs in a row', () => {
    const a = 'one\n'
    const b = 'two lines\nhere\n'
    const buf = concat(
      `aaaaaaaa blob ${Buffer.byteLength(a, 'utf-8')}\n`,
      a,
      '\n',
      `bbbbbbbb blob ${Buffer.byteLength(b, 'utf-8')}\n`,
      b,
      '\n',
    )
    const result = parseCatFileBatch(buf)
    expect(result.get('aaaaaaaa')).toBe(a)
    expect(result.get('bbbbbbbb')).toBe(b)
  })

  it('handles content that embeds newlines', () => {
    const content = 'line1\nline2\nline3'
    const size = Buffer.byteLength(content, 'utf-8')
    const buf = concat(`abc123 blob ${size}\n`, content, '\n')
    expect(parseCatFileBatch(buf).get('abc123')).toBe(content)
  })
})
