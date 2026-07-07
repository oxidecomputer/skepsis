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
import { detectLanguage, getCommentSyntax, getCommentSyntaxes } from './commentSyntax.ts'

describe('detectLanguage', () => {
  it.each([
    // Exact filename match
    ['.zprofile', '', 'Shell'],
    ['.zshrc', '', 'Shell'],
    ['.zshenv', '', 'Shell'],
    ['.bash_profile', '', 'Shell'],
    ['.tmux.conf', '', 'Shell'],
    ['.gitconfig', '', 'Git Config'],
    ['.gitignore', '', 'Ignore List'],
    ['.vimrc', '', 'Vim Script'],
    ['Makefile', '', 'Makefile'],
    ['Dockerfile', '', 'Dockerfile'],
    ['Nukefile', '', 'Nu'],
    // Path shouldn't affect basename lookup
    ['/home/u/.zprofile', '', 'Shell'],
    ['some/dir/Makefile', '', 'Makefile'],

    // Extension match
    ['foo.ts', '', 'TypeScript'],
    ['foo.tsx', '', 'TSX'],
    ['foo.js', '', 'JavaScript'],
    ['foo.py', '', 'Python'],
    ['foo.rs', '', 'Rust'],
    ['foo.lua', '', 'Lua'],
    ['foo.sh', '', 'Shell'],
    ['foo.yaml', '', 'YAML'],
    ['foo.yml', '', 'YAML'],
    ['foo.vue', '', 'Vue'],
    // Ambiguous extensions pinned via override
    ['README.md', '', 'Markdown'],
    ['foo.h', '', 'C'],
    ['foo.r', '', 'R'],
    ['script.nu', '', 'Nushell'],

    // Shebang fallback for extension-less files
    ['somebin', '#!/bin/bash', 'Shell'],
    ['somebin', '#!/usr/bin/env python3', 'Python'],
    ['somebin', '#!/usr/bin/env bash', 'Shell'],
    ['somebin', '#!/usr/bin/env -S bash -eu', 'Shell'],
    ['somebin', '#!/usr/bin/env -S python3 -u', 'Python'],
    ['somebin', '#!/usr/bin/env ruby', 'Ruby'],

    // Filename match wins over shebang
    ['.zprofile', '#!/usr/bin/env node', 'Shell'],
  ])('detectLanguage(%j, %j) → %s', (file, firstLine, expected) => {
    expect(detectLanguage(file, firstLine)).toBe(expected)
  })

  it('returns null for unrecognized files with no shebang', () => {
    expect(detectLanguage('unknown.zzz', '')).toBeNull()
    expect(detectLanguage('no-extension', '')).toBeNull()
    expect(detectLanguage('no-extension', 'not a shebang')).toBeNull()
  })

  it('returns null for ambiguous extensions without overrides', () => {
    expect(detectLanguage('unknown.m', '')).toBeNull()
  })

  it('falls back to shebang when the extension is ambiguous', () => {
    expect(detectLanguage('unknown.m', '#!/usr/bin/env python3')).toBe('Python')
  })

  it('ignores unknown shebang interpreters', () => {
    expect(detectLanguage('somebin', '#!/usr/bin/env made-up-lang')).toBeNull()
  })
})

describe('getCommentSyntax', () => {
  it.each([
    ['.zprofile', '', { prefix: '#' }],
    ['.gitconfig', '', { prefix: '#' }],
    ['.vimrc', '', { prefix: '"' }],
    ['foo.ts', '', { prefix: '//' }],
    ['foo.tsx', '', { prefix: '//' }],
    ['foo.rs', '', { prefix: '//' }],
    ['foo.css', '', { prefix: '/*', suffix: '*/' }],
    ['README.md', '', { prefix: '<!--', suffix: '-->' }],
    ['foo.sql', '', { prefix: '--' }],
    ['foo.lua', '', { prefix: '--' }],
    ['foo.ini', '', { prefix: ';' }],
    ['foo.yaml', '', { prefix: '#' }],
    ['foo.yml', '', { prefix: '#' }],
    ['foo.conf', '', { prefix: '#' }],
    ['foo.vue', '', { prefix: '//' }],
    ['script.nu', '', { prefix: '#' }],
    ['Nukefile', '', { prefix: ';' }],
    ['somebin', '#!/bin/bash', { prefix: '#' }],
    // known-markerless formats get the bare syntax, not null
    ['notes.txt', '', { prefix: '' }],
    ['data.csv', '', { prefix: '' }],
    ['data.tsv', '', { prefix: '' }],
  ])('getCommentSyntax(%j, %j) → %j', (file, firstLine, expected) => {
    expect(getCommentSyntax(file, firstLine)).toEqual(expected)
  })

  it('returns null on unrecognized file', () => {
    expect(getCommentSyntax('unknown.zzz', '')).toBeNull()
  })

  it('returns null on ambiguous file extensions without an override', () => {
    expect(getCommentSyntax('foo.m', '')).toBeNull()
  })

  it('returns null when a detected language has no comment-syntax entry', () => {
    expect(getCommentSyntax('foo.wl', '')).toBeNull()
  })
})

describe('getCommentSyntaxes', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skepsis-test-'))
    await writeFile(join(dir, 'script'), '#!/bin/bash\necho hi\n')
    await writeFile(join(dir, 'data.zzz'), 'stuff\n')
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves a syntax (or null) per file', async () => {
    const files = ['foo.ts', 'script', 'notes.txt', 'data.zzz', 'deleted.zzz']
    expect(await getCommentSyntaxes(dir, files)).toEqual({
      'foo.ts': { prefix: '//' },
      // rescued from unknown by its shebang
      script: { prefix: '#' },
      // known-markerless, not unknown
      'notes.txt': { prefix: '' },
      'data.zzz': null,
      // not on disk: resolves to unknown, which is inert (no addition lines)
      'deleted.zzz': null,
    })
  })
})
