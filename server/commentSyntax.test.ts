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
import { JSX_SECTIONS, SFC_SECTIONS, VUE_SECTIONS } from '../shared/reviewComments.ts'

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
    ['foo.tsx', '', JSX_SECTIONS],
    ['foo.jsx', '', JSX_SECTIONS],
    ['foo.js', '', { prefix: '//' }],
    ['foo.rs', '', { prefix: '//' }],
    ['foo.css', '', { prefix: '/*', suffix: '*/' }],
    ['README.md', '', { prefix: '<!--', suffix: '-->' }],
    ['doc.mdx', '', { prefix: '{/*', suffix: '*/}' }],
    ['foo.sql', '', { prefix: '--' }],
    ['foo.lua', '', { prefix: '--' }],
    ['foo.ini', '', { prefix: ';' }],
    ['foo.yaml', '', { prefix: '#' }],
    ['foo.yml', '', { prefix: '#' }],
    ['foo.conf', '', { prefix: '#' }],
    ['foo.vue', '', VUE_SECTIONS],
    ['foo.svelte', '', SFC_SECTIONS],
    ['foo.astro', '', SFC_SECTIONS],
    ['index.html', '', SFC_SECTIONS],
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
    // an unclosed HTML comment runs to the end
    [['<!--', '<script>'], xml],
    // Tags inside attribute values do not open sections.
    [['<div title="<style>">', '<p>hi</p>'], xml],
    [["<div title='<script>'>", '<p>hi</p>'], xml],
    // A raw section ends only at its complete closing tag name.
    [['<script>', 'const tpl = "</script-editor>"', 'go()'], slash],
    [['<style>', 'p::after { content: "</stylesheet>"; }'], block],
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

  const tsx = [
    'export function List<T,>({ items }: { items: T[] }) {', // 1
    '  const n = items.length < 2 ? <b>few</b> : null', // 2
    '  return (', // 3
    '    <ul', // 4
    '      className="list"', // 5
    '    >', // 6
    '      {items.map((item) => (', // 7
    '        <li key={String(item)}>', // 8
    '          {String(item)}', // 9
    '        </li>', // 10
    '      ))}', // 11
    '      <>', // 12
    '        text', // 13
    '      </>', // 14
    '    </ul>', // 15
    '  )', // 16
    '}', // 17
  ]
  const jsx = { prefix: '{/*', suffix: '*/}' }
  it.each([
    [1, slash],
    [2, slash],
    [3, slash],
    // between attributes, // is a comment
    [4, slash],
    [5, slash],
    [6, jsx],
    // in JS inside {}
    [7, slash],
    [8, jsx],
    [9, jsx],
    [10, slash],
    [11, jsx],
    [12, jsx],
    [13, jsx],
    [14, jsx],
    [15, slash],
    [16, slash],
    [17, slash],
  ])('after line %i of a TSX file → %j', (afterLine, expected) => {
    expect(commentSyntaxAt('List.tsx', tsx, afterLine)).toEqual(expected)
    // No indentation puts the insertion exactly at tag and expression boundaries.
    expect(
      commentSyntaxAt(
        'List.tsx',
        tsx.map((line) => line.trimStart()),
        afterLine,
      ),
    ).toEqual(expected)
  })

  it('switches between JS and JSX inside a prop expression', () => {
    const lines = ['const v = <Panel title={', '<b>', 'title', '</b>', '} />']
    expect(commentSyntaxAt('Panel.tsx', lines, 1)).toEqual(slash)
    expect(commentSyntaxAt('Panel.tsx', lines, 2)).toEqual(jsx)
    expect(commentSyntaxAt('Panel.tsx', lines, 4)).toEqual(slash)
  })

  it('ignores tag-like text in JavaScript literals', () => {
    const lines = [
      'const text = "<div>"',
      'const pattern = /<span>/',
      'const template = `<section>${text}`',
      'const v = <p>',
      '  {template}',
      '</p>',
    ]
    expect(commentSyntaxAt('Literal.jsx', lines, 3)).toEqual(slash)
    expect(commentSyntaxAt('Literal.jsx', lines, 4)).toEqual(jsx)
  })

  it.each([
    [2, slash],
    [4, jsx],
    [5, slash],
    // after </script>
    [8, xml],
  ])('after line %i of a Vue component with a TSX script → %j', (afterLine, expected) => {
    const vue = [
      '<script setup lang="tsx">', // 1
      'const view = () => (', // 2
      '  <div>', // 3
      '    <p>hi</p>', // 4
      '  </div>', // 5
      ')', // 6
      '</script>', // 7
      '<template><view /></template>', // 8
    ]
    expect(commentSyntaxAt('App.vue', vue, afterLine)).toEqual(expected)
    // A preceding script must not shift or truncate the TSX script's content range.
    const prelude = ['<script>', 'export default {}', '</script>']
    expect(
      commentSyntaxAt('App.vue', [...prelude, ...vue], afterLine + prelude.length),
    ).toEqual(expected)
  })

  it('leaves a plain TS script in Vue to //', () => {
    const vue = ['<script setup lang="ts">', 'const a = 1 < 2', '</script>']
    expect(commentSyntaxAt('App.vue', vue, 1)).toEqual(slash)
  })

  it.each([
    '<script setup lang = "tsx">',
    "<script lang = 'jsx'>",
    '<script lang=tsx>',
    '<script generic="T extends Record<string, unknown>" lang="tsx">',
    '<script\n generic="T extends Record<string, unknown>"\n lang = "tsx">',
  ])('reads JSX language attributes in %s', (openTag) => {
    const vue = `${openTag}\nconst v = <div>\nhi\n</div>\n</script>`.split('\n')
    expect(commentSyntaxAt('App.vue', vue, vue.indexOf('const v = <div>') + 1)).toEqual(jsx)
  })

  it('does not read lang from the value of another attribute', () => {
    const vue = [
      `<script data-example=' lang="tsx"' lang="ts">`,
      'const value = <number>',
      '1',
      '</script>',
    ]
    expect(commentSyntaxAt('App.vue', vue, 2)).toEqual(slash)
  })

  it('does not truncate a Vue TSX script at a closing-tag prefix in a string', () => {
    const vue = [
      '<script lang="tsx">',
      'const v = <div>',
      '  {"</script-editor>"}',
      '</div>',
      '</script>',
    ]
    expect(commentSyntaxAt('App.vue', vue, 2)).toEqual(jsx)
    expect(commentSyntaxAt('App.vue', vue, 3)).toEqual(jsx)
  })

  it.each([
    ['const broken = ;\n', ''],
    ['', '\nconst unfinished ='],
  ])('recognizes JSX despite broken code elsewhere (%j, %j)', (before, after) => {
    const lines = `${before}const v = <div>\n  hello\n</div>${after}`.split('\n')
    const afterLine = lines.indexOf('const v = <div>') + 1
    expect(commentSyntaxAt('Editing.tsx', lines, afterLine)).toEqual(jsx)
  })

  it('uses the file syntax for other files', () => {
    expect(commentSyntaxAt('foo.ts', ['<style>'], 1)).toEqual({ prefix: '//' })
    expect(commentSyntaxAt('data.zzz', ['x'], 1)).toEqual({ prefix: '' })
  })
})
