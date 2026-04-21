import { describe, expect, it } from 'vitest'
import { detectLanguage, getCommentSyntax } from './commentSyntax.ts'

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
    ['script.nu', '', { prefix: '#' }],
    ['Nukefile', '', { prefix: ';' }],
    ['somebin', '#!/bin/bash', { prefix: '#' }],
  ])('getCommentSyntax(%j, %j) → %j', (file, firstLine, expected) => {
    expect(getCommentSyntax(file, firstLine)).toEqual(expected)
  })

  it('throws on unrecognized file', () => {
    expect(() => getCommentSyntax('unknown.zzz', '')).toThrow(/unrecognized file type/)
  })

  it('throws on ambiguous file extensions without an override', () => {
    expect(() => getCommentSyntax('foo.m', '')).toThrow(/ambiguous file type/)
  })

  it('throws when a detected language has no comment-syntax entry', () => {
    expect(() => getCommentSyntax('foo.wl', '')).toThrow(/no entry for language/)
  })
})
