/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Page } from '@playwright/test'

import { COMMITTED, expect, LONG_LINES, test, WORKING } from './fixtures.ts'

test.use({ pollMs: 200 })

const banner = (page: Page) => page.getByText('The diff changed on disk')

/** Give the page time for several polls, so a missing banner means something. */
const severalPolls = (page: Page) => page.waitForTimeout(1000)

test('a change on disk shows a banner listing it, and Refresh loads it', async ({
  page,
  repo,
}) => {
  await severalPolls(page)
  await expect(banner(page)).toBeHidden()

  await repo.write('b.txt', 'hello\nworld\nagain\n')
  // Unchanged until now, so it enters the diff.
  await repo.write('long.ts', LONG_LINES.with(29, '// changed').join('\n') + '\n')
  await expect(page.locator('.diff-changed-summary')).toContainText('2 files')
  await expect(page.locator('.diff-changed-summary')).toContainText('+2-1')
  const files = page.locator('.diff-changed-files li')
  await expect(files).toHaveCount(2)
  await expect(files.nth(0)).toHaveText(/^b\.txt\s*\+1$/)
  await expect(files.nth(1)).toHaveText(/^long\.ts\s*new in diff\s*\+1-1$/)
  // Only a banner: the diff itself waits for the refresh.
  await expect(page.getByText('again')).toBeHidden()

  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText('again')).toBeVisible()
  await expect(banner(page)).toBeHidden()
})

test('a failed Refresh keeps the diff on screen', async ({ page, repo }) => {
  await repo.write('b.txt', 'hello\nworld\nagain\n')
  await expect(banner(page)).toBeVisible()

  await page.route('**/api/diff', (route) =>
    route.fulfill({ status: 500, json: { error: 'index.lock exists' } }),
  )
  await page.getByRole('button', { name: 'Refresh' }).click()
  const toast = page.getByText("Couldn't reload the diff: index.lock exists")
  await expect(toast).toBeVisible()
  // toBeVisible ignores opacity, so check the fade lasts as long as the toast.
  await expect(toast).toHaveCSS('animation-duration', '6s')
  await expect(page.locator('.file-header').first()).toBeVisible()
  await expect(banner(page)).toBeVisible()

  // Refresh tries again.
  await page.unroute('**/api/diff')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText('again')).toBeVisible()
})

test('r refreshes once the diff has changed', async ({ page, repo }) => {
  await repo.write('b.txt', 'hello\nworld\nagain\n')
  await expect(banner(page)).toBeVisible()
  await page.keyboard.press('r')
  await expect(page.getByText('again')).toBeVisible()
  await expect(banner(page)).toBeHidden()
})

test.describe('between polls', () => {
  // One poll on load and none after, so a stale hash from before the page's
  // own write would stay on screen.
  test.use({ pollMs: 60_000 })

  test('the page’s own comment does not raise the banner', async ({ page }) => {
    await page.keyboard.press('j')
    await page.keyboard.press('c')
    await page.getByPlaceholder('Leave a review comment').fill('looks wrong')
    await page.getByRole('button', { name: 'Comment' }).click()
    await expect(page.getByText('// looks wrong')).toBeVisible()
    await page.waitForTimeout(300)
    await expect(banner(page)).toBeHidden()
  })

  test('coming back to the tab checks for changes without loading them', async ({
    page,
    repo,
  }) => {
    await repo.write('b.txt', 'hello\nworld\nagain\n')
    // What React Query listens for to tell the tab is back in front.
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    await expect(banner(page)).toBeVisible()
    await expect(page.getByText('again')).toBeHidden()
  })
})

test('a comment draft survives a refresh', async ({ page, repo }) => {
  await page.keyboard.press('j')
  await page.keyboard.press('c')
  const textarea = page.getByPlaceholder('Leave a review comment')
  await textarea.fill('half a thought')

  await repo.write('a.ts', WORKING['a.ts'] + 'const five = 5\n')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText('const five = 5')).toBeVisible()
  await expect(textarea).toHaveValue('half a thought')
})

test('the comment box follows its line when lines are added above', async ({
  page,
  repo,
}) => {
  await page.keyboard.press('j')
  await page.keyboard.press('c')
  await page.getByPlaceholder('Leave a review comment').fill('looks wrong')

  await repo.write('a.ts', 'const zero = 0\n' + WORKING['a.ts'])
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText('const zero = 0')).toBeVisible()
  await page.getByRole('button', { name: 'Comment' }).click()
  await expect(page.getByText('// looks wrong')).toBeVisible()
  // Under const one = 1, which is now line 2, not under line 1.
  expect(await repo.read('a.ts')).toBe(
    'const zero = 0\nconst one = 1\n// <review>\n// looks wrong\n// </review>\nconst two = 22\nconst three = 3\nconst four = 4\n',
  )
})

test('the comment box closes when its line leaves the diff', async ({ page, repo }) => {
  await page.keyboard.press('j')
  await page.keyboard.press('c')
  const textarea = page.getByPlaceholder('Leave a review comment')
  await textarea.fill('half a thought')

  await repo.write('a.ts', COMMITTED['a.ts']!)
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(
    page.getByText('Comment box closed: its line changed or left the diff'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy draft' })).toBeVisible()
  await expect(textarea).toBeHidden()
  // An open box blocks the shortcuts; a closed one doesn't.
  await page.keyboard.press('s')
  await expect(page.getByText('Split mode:')).toBeVisible()
})

const long = (page: Page) =>
  page.locator('diffs-container').filter({
    has: page.locator('.file-header-name').getByText('long.ts', { exact: true }),
  })

/** long.ts as written, with the draft as a comment under line 10. */
const commentedUnder10 = (lines: string[]) =>
  lines.toSpliced(10, 0, '// <review>', '// half a thought', '// </review>').join('\n') +
  '\n'

test.describe('with an expanded file', () => {
  const working = LONG_LINES.with(29, '// line 30 changed')
  test.use({
    repoFiles: {
      committed: COMMITTED,
      working: { ...WORKING, 'long.ts': working.join('\n') + '\n' },
    },
  })

  /** Open the comment box on line 10 of long.ts with the gutter "+". */
  async function draftOnLine10(page: Page) {
    const number = long(page).locator('[data-additions] [data-column-number="10"]').first()
    await expect(async () => {
      await number.hover()
      await number.locator('[data-gutter-utility-slot]').click({ timeout: 1000 })
    }).toPass({ timeout: 7000 })
    const textarea = page.getByPlaceholder('Leave a review comment')
    await textarea.fill('half a thought')
    return textarea
  }

  test('the comment box stays on a revealed line when another file changes', async ({
    page,
    repo,
  }) => {
    await long(page).locator('[data-expand-button]:visible').first().click()
    const textarea = await draftOnLine10(page)

    await repo.write('b.txt', 'hello\nnew line\n')
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.getByText('new line')).toBeVisible()
    await expect(textarea).toHaveValue('half a thought')
    await page.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(textarea).toBeHidden()
    expect(await repo.read('long.ts')).toBe(commentedUnder10(working))
  })

  test('with Expand all, the comment box follows its line while the file reloads', async ({
    page,
    repo,
  }) => {
    await long(page).getByRole('button', { name: 'Expand all lines', exact: true }).click()
    const textarea = await draftOnLine10(page)

    // Slow enough that the refetched diff arrives well before the contents.
    await page.route('**/api/file-contents?*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await route.continue()
    })
    const edited = working.with(49, '// line 50 changed')
    await repo.write('long.ts', edited.join('\n') + '\n')
    const contents = page.waitForResponse('**/api/file-contents?*')
    await page.getByRole('button', { name: 'Refresh' }).click()
    await contents
    await expect(banner(page)).toBeHidden()
    await expect(textarea).toHaveValue('half a thought')
    await page.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(textarea).toBeHidden()
    expect(await repo.read('long.ts')).toBe(commentedUnder10(edited))
  })
})

test.describe('with --no-poll', () => {
  test.use({ cliArgs: ['--no-poll'] })

  test('never polls or shows the banner', async ({ page, repo }) => {
    const polls: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/api/diff-hash')) polls.push(r.url())
    })
    await repo.write('b.txt', 'hello\nworld\nagain\n')
    await severalPolls(page)
    await expect(banner(page)).toBeHidden()
    expect(polls).toEqual([])
  })
})

const base = (name: string) =>
  Array.from({ length: 400 }, (_, i) => `const ${name}${i + 1} = ${i + 1}`)

// CodeView keeps the reader's place across the refetch on its own (a change
// to an item above the viewport adjusts the scroll offset). These guard that.
test.describe('with edits above the viewport', () => {
  /** The file changed at line 10, with `extra` lines added under it, and in a
   *  block of 40 lines further down, from what was line 301, long enough that
   *  the page scrolls. */
  const edit = (name: string, extra: number) => {
    const lines = base(name)
    lines[9] = `const ${name}10 = "changed"`
    lines.splice(
      10,
      0,
      ...Array.from({ length: extra }, (_, i) => `const ${name}_added${i} = 0`),
    )
    for (let i = 300; i < 340; i++) lines[i + extra] = `const ${name}${i + 1} = "changed"`
    return lines.join('\n') + '\n'
  }
  test.use({
    repoFiles: {
      committed: {
        'a.ts': base('a').join('\n') + '\n',
        'big.ts': base('b').join('\n') + '\n',
      },
      working: { 'a.ts': edit('a', 1), 'big.ts': edit('b', 1) },
    },
  })

  for (const [where, file, name] of [
    ['the same file', 'big.ts', 'b'],
    ['an earlier file', 'a.ts', 'a'],
  ] as const) {
    test(`Refresh keeps the reader’s place when ${where} grows`, async ({ page, repo }) => {
      // Near the end of the diff, away from the bottom so the offset isn't
      // clamped.
      const root = page.locator('.codeview-root')
      await root.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 300))
      const reading = page.getByText('const b330 = "changed"')
      await expect(reading).toBeVisible()
      await page.waitForTimeout(300) // let the virtualizer settle
      const before = (await reading.boundingBox())!.y

      await repo.write(file, edit(name, 30))
      await page.getByRole('button', { name: 'Refresh' }).click()
      await expect(banner(page)).toBeHidden()
      // Unanchored, 29 more lines above would push it down about 580px.
      await page.waitForTimeout(300)
      expect((await reading.boundingBox())!.y).toBeCloseTo(before, -2)
    })
  }
})
