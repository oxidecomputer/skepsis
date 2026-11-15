/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { COMMITTED, expect, test, WORKING } from './fixtures.ts'

const WIDTH = 390
test.use({ viewport: { width: WIDTH, height: 844 }, hasTouch: true })

test('the page fits the width, with the help button on screen', async ({ page }) => {
  const help = page.getByRole('button', { name: 'Keyboard shortcuts' })
  await expect(help).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(WIDTH)
  await page.getByRole('button', { name: 'Show file tree' }).tap()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(WIDTH)
})

test('the file tree is a drawer that closes on a pick', async ({ page }) => {
  const tree = page.locator('.file-tree')
  const diff = page.locator('.codeview-root')
  const stored = () => page.evaluate(() => localStorage.getItem('skepsis.fileTreeOpen'))
  // Closed to start, though the stored sidebar preference defaults to open
  await expect(tree).toBeHidden()
  const diffWidth = (await diff.boundingBox())!.width

  await page.getByRole('button', { name: 'Show file tree' }).tap()
  await expect(tree).toBeVisible()
  // Over the diff, not beside it
  expect((await diff.boundingBox())!.width).toBe(diffWidth)
  await tree.getByRole('treeitem', { name: 'b.txt' }).tap()
  await expect(tree).toBeHidden()
  await expect(page.locator('.file-header.focused .file-header-name')).toHaveText('b.txt')

  // A tap beside the drawer closes it, and so does Escape
  await page.getByRole('button', { name: 'Show file tree' }).tap()
  await page.locator('.file-tree-backdrop').tap({ position: { x: WIDTH - 20, y: 100 } })
  await expect(tree).toBeHidden()
  await page.keyboard.press('b')
  await expect(tree).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tree).toBeHidden()

  // None of that touched the sidebar preference
  expect(await stored()).toBeNull()
  await page.reload()
  await page.locator('.file-header').first().waitFor()
  await expect(tree).toBeHidden()
})

test.describe('a long file name', () => {
  const name = 'a_file_name_long_enough_to_be_truncated_in_the_file_header.ts'
  test.use({ repoFiles: { committed: COMMITTED, working: { ...WORKING, [name]: 'hi\n' } } })

  test('keeps its end in the file header', async ({ page }) => {
    const header = page.locator('.file-header', { hasText: 'file_header.ts' })
    const box = (await header.locator('.file-header-name').boundingBox())!
    const path = (await header.locator('.file-header-path').boundingBox())!
    // Wider than its box, cut at the start
    expect(path.x).toBeLessThan(box.x)
    expect(path.x + path.width).toBeCloseTo(box.x + box.width, 0)
  })
})

test('a tap on a line number starts a comment', async ({ page, repo }) => {
  const number = page
    .locator('diffs-container')
    .first()
    .locator('[data-column-number="4"]')
    .last()
  await number.tap()
  await number.locator('[data-gutter-utility-slot]').tap()
  await page.getByPlaceholder('Leave a review comment').fill('from a phone')
  await page.getByRole('button', { name: 'Comment' }).tap()
  await expect(page.getByText('// from a phone')).toBeVisible()
  expect(await repo.read('a.ts')).toBe(
    'const one = 1\nconst two = 22\nconst three = 3\nconst four = 4\n// <review>\n// from a phone\n// </review>\n',
  )
})
