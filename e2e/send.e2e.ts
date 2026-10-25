/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test, WORKING } from './fixtures.ts'

// Appends each payload to a file in .git, out of the diff's way.
const SEND = 'cat >> .git/sent.jsonl'

/** The payloads sent so far. */
async function sent(dir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(dir, '.git', 'sent.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The git blob ID of a file's contents. */
const blobId = (contents: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(contents)}\0${contents}`)
    .digest('hex')

const textarea = (page: Page) => page.getByPlaceholder('Leave a review comment')

/** Open the comment box on the first line of a.ts with the line cursor. */
async function openBox(page: Page) {
  await page.keyboard.press('j')
  await page.keyboard.press('c')
  await expect(textarea(page)).toBeFocused()
}

/** Click the gutter "+" on a line of a.ts. */
async function clickPlus(page: Page, side: 'additions' | 'deletions', line: number) {
  const number = page
    .locator('diffs-container')
    .first()
    .locator(`[data-${side}] [data-column-number="${line}"]`)
    .first()
  // A re-render shortly after load can drop the hovered "+"; hover again.
  await expect(async () => {
    await number.hover()
    await number.locator('[data-gutter-utility-slot]').click({ timeout: 1000 })
  }).toPass()
}

test.describe('with --send', () => {
  test.use({ cliArgs: ['--send', SEND] })

  test('Send pipes the comment to the command', async ({ page, repo }) => {
    await openBox(page)
    await textarea(page).fill('looks wrong')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    await expect(textarea(page)).toBeHidden()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({
      version: 1,
      file: 'a.ts',
      side: 'additions',
      lines: [1, 1],
      code: { lines: [1, 3], text: 'const one = 1\nconst two = 22\nconst three = 3' },
      text: 'looks wrong',
    })
    expect(payload!['blob']).toMatch(/^[0-9a-f]{7,}$/)
    expect(payload!['prompt']).toMatch(
      /^Review comment on a\.ts, line 1 \(new side of `git[^`]*`\), in lines 1–3:/,
    )
    // Nothing written into the file
    expect(await repo.read('a.ts')).toBe(WORKING['a.ts'])
  })

  test('a sent comment stays in the diff until dismissed', async ({ page }) => {
    await openBox(page)
    await textarea(page).fill('first')
    await page.keyboard.press('ControlOrMeta+Enter')
    const cards = page.locator('.sent-comment')
    await expect(cards).toHaveCount(1)
    await openBox(page)
    await textarea(page).fill('second')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(cards).toHaveCount(2)
    await expect(cards.first()).toContainText('Sent')
    await expect(cards.first()).toContainText('first')
    await expect(cards.nth(1)).toContainText('second')

    await cards.first().getByRole('button', { name: 'Dismiss' }).click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('second')
  })

  test('the submit keys send; the inline keys write a marker', async ({ page, repo }) => {
    await openBox(page)
    await textarea(page).fill('by keyboard')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    expect((await sent(repo.dir)).map((p) => p['text'])).toEqual(['by keyboard'])

    await openBox(page)
    await textarea(page).fill('inline')
    await page.keyboard.press('ControlOrMeta+Alt+Enter')
    await expect(page.getByText('// inline')).toBeVisible()
    expect(await repo.read('a.ts')).toContain('// <review>\n// inline\n// </review>\n')
    expect(await sent(repo.dir)).toHaveLength(1)
  })

  test('Comment still writes a marker', async ({ page, repo }) => {
    await openBox(page)
    await textarea(page).fill('marker please')
    await page.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(page.getByText('// marker please')).toBeVisible()
    expect(await repo.read('a.ts')).toContain('// marker please')
    expect(await sent(repo.dir)).toEqual([])
  })

  test('a send describes the version on screen, not a newer one on disk', async ({
    page,
    repo,
  }) => {
    await openBox(page)
    await textarea(page).fill('looks wrong')
    // No Refresh: the page still shows the old a.ts.
    await repo.write('a.ts', 'const zero = 0\n' + WORKING['a.ts'])
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({ lines: [1, 1], code: { lines: [1, 3] } })
    expect(blobId(WORKING['a.ts']!)).toMatch(new RegExp(`^${payload!['blob']}`))
  })

  test('a removed line can be sent, but not commented inline', async ({ page, repo }) => {
    // a.ts line 2 (`const two = 2`) is removed
    await clickPlus(page, 'deletions', 2)
    await expect(
      page.getByText('Inline comments go on the new side of the diff'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeDisabled()
    await textarea(page).fill('why change this?')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({
      side: 'deletions',
      lines: [2, 2],
      text: 'why change this?',
    })
    expect(payload!['code']).toEqual({
      lines: [1, 3],
      text: 'const one = 1\nconst two = 2\nconst three = 3',
    })
    expect(payload!['prompt']).toMatch(/line 2 \(old side of/)
  })
})

test.describe('with a failing --send', () => {
  test.use({ cliArgs: ['--send', 'echo "nobody home" >&2; exit 1'] })

  test('shows the error and keeps the draft', async ({ page }) => {
    await openBox(page)
    await textarea(page).fill('keep me')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('nobody home')).toBeVisible()
    await expect(textarea(page)).toHaveValue('keep me')
  })
})

test.describe('with --send on a diff that ends at a commit', () => {
  // The empty tree to HEAD: every committed file, and no working copy, so
  // inline comments are off.
  test.use({
    cliArgs: ['--send', SEND, '-r', '4b825dc642cb6eb9a060e54bf8d69288fbee4904..HEAD'],
  })

  test('Send still works', async ({ page, repo }) => {
    await expect(
      page.getByText('Inline comments are off for this diff, but Send still works.'),
    ).toBeVisible()
    await openBox(page)
    await expect(
      page.getByText('Inline comments need the diff to end at the working copy'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeDisabled()
    await textarea(page).fill('on a commit')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({ diff: { toWorkingCopy: false }, text: 'on a commit' })
  })
})

test('without --send, the box only comments inline', async ({ page }) => {
  await openBox(page)
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
})
