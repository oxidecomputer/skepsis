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
import {
  commentSyntaxAt,
  detectLanguage,
  getCommentSyntax,
  getCommentSyntaxes,
} from './commentSyntax.ts'

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
    ['.vimrc', '', 'Vim script'],
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
    ['foo.svelte', '', 'Svelte'],
    // Ambiguous extensions pinned via override
    ['README.md', '', 'Markdown'],
    ['index.html', '', 'HTML'],
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
    ['foo.vue', '', 'sectioned'],
    ['foo.svelte', '', 'sectioned'],
    ['foo.astro', '', 'sectioned'],
    ['index.html', '', 'sectioned'],
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

describe('commentSyntaxAt', () => {
  const svelte = [
    '<script lang="ts" generics="T extends Record<string, unknown>">', // 1
    '  let count = $state(0)', // 2
    '</script>', // 3
    '<!-- <style> -->', // 4
    '<button>{count}</button>', // 5
    '<script src="x.js" />', // 6
    '<style>', // 7
    '  button { color: red; }', // 8
    '</style>', // 9
  ]

  it.each([
    [0, { prefix: '<!--', suffix: '-->' }],
    [1, { prefix: '//' }],
    [2, { prefix: '//' }],
    [3, { prefix: '<!--', suffix: '-->' }],
    // a tag inside an HTML comment doesn't open a section
    [4, { prefix: '<!--', suffix: '-->' }],
    // nor does a self-closing one
    [6, { prefix: '<!--', suffix: '-->' }],
    [7, { prefix: '/*', suffix: '*/' }],
    [8, { prefix: '/*', suffix: '*/' }],
    [9, { prefix: '<!--', suffix: '-->' }],
  ])('after line %i of a Svelte file → %j', (afterLine, expected) => {
    expect(commentSyntaxAt('App.svelte', svelte, afterLine)).toEqual(expected)
  })

  const slash = { prefix: '//' }
  const block = { prefix: '/*', suffix: '*/' }
  const xml = { prefix: '<!--', suffix: '-->' }
  it.each([
    // tags in JS strings, in TS generics, and in review comments in script
    // are raw text: only </script> ends it
    [['<script>', "const tpl = '<style>.a{}</style>'"], slash],
    [['<script>', 'const s = ref<Style>()', '// see <style scoped>'], slash],
    // an unpaired <!-- in script doesn't open a comment
    [['<script>', "html.indexOf('<!--')", '</script>', '<!-- main -->', '<p>x</p>'], xml],
    // same for style
    [['<style>', '/* compute this in <script> instead */', 'p {}'], block],
    // components and custom elements aren't sections
    [['<script-editor>', '  <p>x</p>'], xml],
    [['<Style>', '  <p>x</p>'], xml],
    // Tags inside attribute values do not open sections.
    [['<div title="<style>">', '<p>hi</p>'], xml],
    [["<div title='<script>'>", '<p>hi</p>'], xml],
    // A raw section ends only at its complete closing tag name.
    [['<script>', 'const tpl = "</script-editor>"', 'go()'], slash],
    [['<style>', 'p::after { content: "</stylesheet>"; }'], block],
    // an unclosed HTML comment runs to the end
    [['<!--', '<script>'], xml],
  ])('after %j → %j', (lines, expected) => {
    expect(commentSyntaxAt('App.svelte', lines, lines.length)).toEqual(expected)
  })

  it('treats HTML pages like components', () => {
    const page = ['<body>', '<script type="module">', 'go()', '</script>', '</body>']
    expect(commentSyntaxAt('index.html', page, 1)).toEqual(xml)
    expect(commentSyntaxAt('index.html', page, 2)).toEqual(slash)
    expect(commentSyntaxAt('index.html', page, 4)).toEqual(xml)
  })

  it('matches HTML section tags case-insensitively', () => {
    const page = ['<STYLE>', 'p {}', '</style>', '<script>', 'go()', '</SCRIPT>']
    expect(commentSyntaxAt('index.html', page, 2)).toEqual(block)
    expect(commentSyntaxAt('index.html', page, 3)).toEqual(xml)
    expect(commentSyntaxAt('index.html', page, 5)).toEqual(slash)
    expect(commentSyntaxAt('index.html', page, 6)).toEqual(xml)
  })

  it.each([
    [1, slash],
    [2, slash],
    // after the closing fence
    [3, xml],
    [5, block],
  ])('after line %i of an Astro component → %j', (afterLine, expected) => {
    const astro = [
      '---',
      "const title = '<style>'",
      '---',
      '<h1>{title}</h1>',
      '<style>',
      '</style>',
    ]
    expect(commentSyntaxAt('Page.astro', astro, afterLine)).toEqual(expected)
  })

  it('reads an Astro component without frontmatter as markup', () => {
    expect(commentSyntaxAt('Page.astro', ['<h1>hi</h1>'], 1)).toEqual(xml)
  })

  it('uses the file syntax for other files', () => {
    expect(commentSyntaxAt('foo.ts', ['<style>'], 1)).toEqual({ prefix: '//' })
    expect(commentSyntaxAt('data.zzz', ['x'], 1)).toEqual({ prefix: '' })
  })
})
