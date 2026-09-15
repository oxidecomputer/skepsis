/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Page } from '@playwright/test'

import { expect, test } from './fixtures.ts'

const storedTheme = (page: Page) =>
  page.evaluate(() => fetch('/api/theme').then((r) => r.json() as Promise<unknown>))

test.describe('desktop set to light', () => {
  test.use({ colorScheme: 'light' })

  test('toggling back to the OS value clears the override', async ({ page }) => {
    const html = page.locator('html')
    // No override yet: the page follows the OS, so no attribute at all.
    await expect(html).not.toHaveAttribute('data-theme', /.*/)

    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    expect(await storedTheme(page)).toEqual({ theme: 'dark' })

    // Dark is now an override, and the next press lands on light — what the
    // OS already says — so it stores 'system' instead of pinning light.
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await expect(html).not.toHaveAttribute('data-theme', /.*/)
    expect(await storedTheme(page)).toEqual({ theme: 'system' })
  })
})

test.describe('desktop set to dark', () => {
  test.use({ colorScheme: 'dark' })

  test('a forced theme survives a reload', async ({ page }) => {
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)

    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    // The boot script stamps the stored override before first paint.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible()
  })
})
