/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { expect, test } from './fixtures.ts'

test('the token leaves the address bar', async ({ page }) => {
  expect(page.url()).not.toContain('token')
})

test('a new tab on the bare URL works', async ({ page, repo }) => {
  const tab = await page.context().newPage()
  await tab.goto(new URL(repo.url).origin)
  await expect(tab.locator('.file-header').first()).toBeVisible()
})

test('another browser on the bare URL is turned away', async ({ browser, repo }) => {
  const other = await browser.newContext()
  const page = await other.newPage()
  await page.goto(new URL(repo.url).origin)
  // At once: retrying can't fix a missing token, so the page doesn't.
  await expect(page.getByRole('alert')).toContainText('No valid access token', {
    timeout: 2000,
  })
  await other.close()
})
