/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { expect, test, WORKING } from './fixtures.ts'

test('renders the diff', async ({ page }) => {
  await expect(page.locator('.file-header-name')).toHaveText(['a.ts', 'b.txt'])
  await expect(page.getByText('const four = 4')).toBeVisible()
  await expect(page.getByText('world')).toBeVisible()
})

test('viewed state persists across reload', async ({ page }) => {
  const viewed = page.locator('.viewed-button').first()
  await expect(viewed).not.toHaveClass(/checked/)
  await viewed.click()
  await expect(viewed).toHaveClass(/checked/)
  await page.reload()
  await expect(page.locator('.viewed-button').first()).toHaveClass(/checked/)
})

test('comment appears in the diff without a reload', async ({ page, repo }) => {
  // j snaps the line cursor to the first visible line of the focused file,
  // c opens the comment form there.
  await page.keyboard.press('j')
  await page.keyboard.press('c')
  const textarea = page.getByPlaceholder('Leave a review comment')
  await textarea.fill('looks wrong')
  await page.getByRole('button', { name: 'Comment' }).click()

  await expect(page.getByText('// looks wrong')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resolve comment' })).toBeVisible()
  expect(await repo.read('a.ts')).toBe(
    'const one = 1\n// <review>\n// looks wrong\n// </review>\nconst two = 22\nconst three = 3\nconst four = 4\n',
  )
})

test('resolving a comment removes it', async ({ page, repo }) => {
  await repo.write(
    'a.ts',
    'const one = 1\n// <review>\n// looks wrong\n// </review>\nconst two = 22\nconst three = 3\nconst four = 4\n',
  )
  await page.reload()
  await expect(page.getByText('// looks wrong')).toBeVisible()

  await page.getByRole('button', { name: 'Resolve comment' }).click()

  await expect(page.getByText('// looks wrong')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Resolve comment' })).toBeHidden()
  expect(await repo.read('a.ts')).toBe(WORKING['a.ts'])
})

test('file tree navigates and collapses', async ({ page }) => {
  const tree = page.locator('.file-tree')
  // Row text is duplicated for the tree's middle-truncation, so match names.
  await expect(tree.getByRole('treeitem', { name: 'a.ts' })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'b.txt' })).toBeVisible()
  await expect(tree.getByRole('treeitem')).toHaveCount(2)

  // Clicking a row focuses that file in the diff.
  await tree.getByRole('treeitem', { name: 'b.txt' }).click()
  await expect(page.locator('.file-header.focused .file-header-name')).toHaveText('b.txt')

  // The toggle hides the tree, and the choice survives a reload.
  await page.getByRole('button', { name: 'Hide file tree' }).click()
  await expect(tree).toBeHidden()
  await page.reload()
  await page.locator('.file-header').first().waitFor()
  await expect(page.locator('.file-tree')).toBeHidden()
  await page.getByRole('button', { name: 'Show file tree' }).click()
  await expect(page.locator('.file-tree')).toBeVisible()
})

test('cmd/ctrl+k focuses the file search, opening the tree if needed', async ({ page }) => {
  // Playwright pierces the tree's open shadow root, so the input is reachable.
  const search = page.locator('.file-tree input')
  await page.locator('.file-header').first().waitFor()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(search).toBeFocused()

  await page.getByRole('button', { name: 'Hide file tree' }).click()
  await expect(page.locator('.file-tree')).toBeHidden()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.locator('.file-tree')).toBeVisible()
  await expect(page.locator('.file-tree input')).toBeFocused()
})
