/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertComment, removeComment } from './comment.ts'

describe('section-aware comments', () => {
  let dir: string
  const original = [
    '<template>',
    '  <p>hi</p>',
    '</template>',
    '<script setup>',
    'const a = 1',
    '</script>',
    '<style>',
    'p {}',
    '</style>',
  ].join('\n')
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skepsis-test-'))
    await writeFile(join(dir, 'App.vue'), original)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('inserts each comment with its section marker and removes it again', async () => {
    // bottom up, so the earlier line numbers stay put
    await insertComment(dir, 'App.vue', 8, 'p {}', 'in style')
    await insertComment(dir, 'App.vue', 5, 'const a = 1', 'in script')
    await insertComment(dir, 'App.vue', 2, '  <p>hi</p>', 'in markup')
    const read = () => readFile(join(dir, 'App.vue'), 'utf-8')
    expect(await read()).toBe(
      [
        '<template>',
        '  <p>hi</p>',
        '  <!-- <review> -->',
        '  <!-- in markup -->',
        '  <!-- </review> -->',
        '</template>',
        '<script setup>',
        'const a = 1',
        '// <review>',
        '// in script',
        '// </review>',
        '</script>',
        '<style>',
        'p {}',
        '/* <review> */',
        '/* in style */',
        '/* </review> */',
        '</style>',
      ].join('\n'),
    )
    await removeComment(dir, 'App.vue', 15)
    await removeComment(dir, 'App.vue', 9)
    await removeComment(dir, 'App.vue', 3)
    expect(await read()).toBe(original)
  })

  it("removes a comment whose marker doesn't match its section", async () => {
    // an older version wrote // everywhere in Vue files
    const lines = [
      '<template>',
      '  <p>hi</p>',
      '  // <review>',
      '  // old',
      '  // </review>',
      '</template>',
    ]
    await writeFile(join(dir, 'Old.vue'), lines.join('\n'))
    await removeComment(dir, 'Old.vue', 3)
    expect(await readFile(join(dir, 'Old.vue'), 'utf-8')).toBe(
      '<template>\n  <p>hi</p>\n</template>',
    )
  })

  it('inserts and removes a JSX comment in a Vue TSX script', async () => {
    const lines = [
      '<script setup lang="tsx">',
      'const v = () => (',
      '  <div>',
      '    <p>hi</p>',
      '  </div>',
      ')',
      '</script>',
    ]
    await writeFile(join(dir, 'Jsx.vue'), lines.join('\n'))
    await insertComment(dir, 'Jsx.vue', 4, '    <p>hi</p>', 'in JSX')
    const read = () => readFile(join(dir, 'Jsx.vue'), 'utf-8')
    expect((await read()).split('\n').slice(4, 7)).toEqual([
      '    {/* <review> */}',
      '    {/* in JSX */}',
      '    {/* </review> */}',
    ])
    await removeComment(dir, 'Jsx.vue', 5)
    expect(await read()).toBe(lines.join('\n'))
  })

  it('inserts a second JSX comment into an already annotated file', async () => {
    const source = ['const v = <div>', '  <p>one</p>', '  <p>two</p>', '</div>'].join('\n')
    await writeFile(join(dir, 'View.tsx'), source)
    await insertComment(dir, 'View.tsx', 2, '  <p>one</p>', 'first')
    await insertComment(dir, 'View.tsx', 6, '  <p>two</p>', 'second')
    const read = () => readFile(join(dir, 'View.tsx'), 'utf-8')
    expect(await read()).toBe(
      [
        'const v = <div>',
        '  <p>one</p>',
        '  {/* <review> */}',
        '  {/* first */}',
        '  {/* </review> */}',
        '  <p>two</p>',
        '  {/* <review> */}',
        '  {/* second */}',
        '  {/* </review> */}',
        '</div>',
      ].join('\n'),
    )
    await removeComment(dir, 'View.tsx', 7)
    await removeComment(dir, 'View.tsx', 3)
    expect(await read()).toBe(source)
  })

  it.each([
    ['style.css', 'p {}', 'no a*/b', '/* no a* /b */'],
    ['page.html', '<p>hi</p>', 'x --> y', '<!-- x -- > y -->'],
    ['View.tsx', 'const v = <div>', '/a*/ and -->', '{/* /a* / and --> */}'],
  ])('keeps text in %s from closing its comment', async (file, line, text, expected) => {
    await writeFile(join(dir, file), `${line}\n</div>`)
    await insertComment(dir, file, 1, line, text)
    const lines = (await readFile(join(dir, file), 'utf-8')).split('\n')
    expect(lines[2]).toBe(expected)
  })
})
