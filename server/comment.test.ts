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

describe('section-aware comments in a Vue file', () => {
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
})
