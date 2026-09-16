/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Locator, Page } from '@playwright/test'

import { expect, test, WORKING } from './fixtures.ts'

async function selectText(page: Page, locator: Locator) {
  await locator.waitFor()
  const box = (await locator.boundingBox())!
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBeTruthy()
}

test('renders the diff', async ({ page }) => {
  await expect(page.locator('.file-header-name')).toHaveText(['a.ts', 'b.txt'])
  await expect(page.getByText('const four = 4')).toBeVisible()
  await expect(page.getByText('world')).toBeVisible()
})

test('header clicks work after selecting code', async ({ page }) => {
  const header = page.locator('.file-header').first()
  // This regression needs an existing selection, independent of mouse-drag
  // timing while the syntax highlighter replaces the code rows.
  const selected = await page.getByText('const four = 4').evaluate((line) => {
    const range = document.createRange()
    range.selectNodeContents(line)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  })
  expect(selected).toContain('const four = 4')

  await header.locator('.collapse-chevron').click()
  await expect(header.locator('.collapse-chevron')).toHaveClass(/collapsed/)
  await expect(page.getByText('const four = 4')).toBeHidden()
  await header.click({ position: { x: 300, y: 15 } })
  await expect(page.getByText('const four = 4')).toBeVisible()
})

test('selecting a filename preserves the selection and the next header click works', async ({
  page,
}) => {
  const header = page.locator('.file-header').first()
  await selectText(page, header.locator('.file-header-name'))
  await expect(header.locator('.collapse-chevron')).not.toHaveClass(/collapsed/)
  await expect(page.getByText('const four = 4')).toBeVisible()

  await header.locator('.collapse-chevron').click()
  await expect(page.getByText('const four = 4')).toBeHidden()
})

test('typing in file search does not trigger diff shortcuts', async ({ page }) => {
  const search = page.locator('.file-tree input')
  await search.click()
  await search.pressSequentially('review')
  await expect(search).toHaveValue('review')
  await expect(page.locator('.viewed-button.checked')).toHaveCount(0)
  await expect(page.locator('.collapse-chevron.collapsed')).toHaveCount(0)

  await search.fill('')
  await search.pressSequentially('a.ts')
  await expect(search).toHaveValue('a.ts')
  await expect(page.locator('.file-tree').getByRole('treeitem')).toHaveCount(1)
})

for (const area of ['code', 'gutter', 'header'] as const) {
  test(`clicking the diff ${area} after searching restores file shortcuts`, async ({
    page,
  }) => {
    const search = page.locator('.file-tree input')
    await search.click()
    await search.pressSequentially('a.ts')
    await expect(search).toHaveValue('a.ts')

    if (area === 'code') {
      await page.getByText('const four = 4').click()
    } else if (area === 'gutter') {
      await page
        .locator('diffs-container')
        .first()
        .locator('[data-gutter] [data-column-number]')
        .first()
        .click()
    } else {
      await page
        .locator('.file-header')
        .first()
        .click({ position: { x: 300, y: 15 } })
    }

    await expect(search).not.toBeFocused()
    await page.keyboard.press('n')
    await expect(page.locator('.file-header.focused .file-header-name')).toHaveText('b.txt')
    await expect(search).not.toHaveValue(/n/)

    await page.keyboard.press('ControlOrMeta+k')
    await expect(search).toBeFocused()
  })
}

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
