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

import { COMMITTED, expect, LONG_LINES, test, WORKING } from './fixtures.ts'

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
      code: [{ lines: [1, 3], text: 'const one = 1\nconst two = 22\nconst three = 3' }],
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
    expect(payload).toMatchObject({ lines: [1, 1], code: [{ lines: [1, 3] }] })
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
    expect(payload!['code']).toEqual([
      { lines: [1, 3], text: 'const one = 1\nconst two = 2\nconst three = 3' },
    ])
    expect(payload!['prompt']).toMatch(/line 2 \(old side of/)
  })
})

test.describe('with --send and lines hidden between hunks', () => {
  const working = LONG_LINES.with(9, '// line 10 changed').with(49, '// line 50 changed')
  test.use({
    cliArgs: ['--send', SEND],
    repoFiles: { committed: COMMITTED, working: { 'long.ts': working.join('\n') + '\n' } },
  })

  test('a range across hidden lines sends each visible run', async ({ page, repo }) => {
    const number = (n: number) =>
      page
        .locator('diffs-container')
        .first()
        .locator(`[data-additions] [data-column-number="${n}"]`)
        .first()
    // Drag the "+" from line 10 down to line 50, across the collapsed lines.
    await expect(async () => {
      await number(10).hover()
      await expect(number(10).locator('[data-gutter-utility-slot]')).toBeVisible({
        timeout: 1000,
      })
    }).toPass()
    const start = (await number(10).locator('[data-gutter-utility-slot]').boundingBox())!
    const end = (await number(50).boundingBox())!
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 })
    await page.mouse.up()
    await textarea(page).fill('these two')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    const run = (first: number, last: number) => ({
      lines: [first, last],
      text: working.slice(first - 1, last).join('\n'),
    })
    expect(payload).toMatchObject({ lines: [10, 50], code: [run(8, 13), run(47, 52)] })
  })
})

/** The rendered row of a line, in the first file. */
const row = (page: Page, side: 'additions' | 'deletions', line: number) =>
  page.locator(`diffs-container [data-${side}] [data-content] > [data-line="${line}"]`)

/** The slot a box on part of a line shows in, in that line */
const inLine = (page: Page, line: number) =>
  row(page, 'additions', line).locator('slot[name="comment-inline"]')

test.describe('with --send, selecting text', () => {
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6).trim()
  test.use({
    cliArgs: ['--send', SEND],
    repoFiles: {
      committed: { 'doc.md': '# Title\n\nold text\n\nend\n' },
      working: { 'doc.md': `# Title\n\n${para}\n\nend\n` },
    },
  })

  test('a word sends with its columns, marked in the prompt', async ({ page, repo }) => {
    await row(page, 'additions', 3).dblclick({ position: { x: 24, y: 4 } })
    await expect(textarea(page)).toBeFocused()
    await expect(inLine(page, 3)).toHaveCount(1)
    await textarea(page).fill('which word?')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(page.locator('.sent-comment .comment-quote')).toHaveText('Lorem')
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({ side: 'additions', lines: [3, 3], columns: [0, 5] })
    expect(payload!['prompt']).toContain('on the text between ⟦ and ⟧')
    expect(payload!['prompt']).toContain('\n⟦Lorem⟧ ipsum dolor')
  })

  test('Comment on a word says the word in its marker', async ({ page, repo }) => {
    await row(page, 'additions', 3).dblclick({ position: { x: 24, y: 4 } })
    await textarea(page).fill('which word?')
    await page.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(textarea(page)).toBeHidden()
    expect(await repo.read('doc.md')).toContain(
      `${para}\n<!-- <review on="Lorem"> -->\n<!-- which word? -->\n`,
    )
  })

  test('a drag inside one line sends the part dragged over', async ({ page, repo }) => {
    const box = (await row(page, 'additions', 3).boundingBox())!
    await page.mouse.move(box.x + 60, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + 160, box.y + 4, { steps: 5 })
    await page.mouse.up()
    await textarea(page).fill('this part')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    const [start, end] = payload!['columns'] as [number, number]
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(payload!['prompt']).toContain(
      `${para.slice(0, start)}⟦${para.slice(start, end)}⟧${para.slice(end)}`,
    )
  })

  test('a triple-click is a comment on the whole line', async ({ page, repo }) => {
    await row(page, 'additions', 3).click({ clickCount: 3, position: { x: 24, y: 4 } })
    await expect(textarea(page)).toBeFocused()
    await expect(page.locator('.comment-inline')).toHaveCount(0)
    await textarea(page).fill('whole thing')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({ lines: [3, 3], columns: null })
  })

  test('selecting part of a line after a whole line unmarks the whole line', async ({
    page,
  }) => {
    // Lines 1–2, the title and the blank line under it
    const title = (await row(page, 'additions', 1).boundingBox())!
    const lorem = (await row(page, 'additions', 3).boundingBox())!
    await page.mouse.move(title.x + 4, title.y + 4)
    await page.mouse.down()
    await page.mouse.move(lorem.x + 1, lorem.y + 4, { steps: 5 })
    await page.mouse.up()
    await expect(row(page, 'additions', 1)).toHaveAttribute('data-selected-line')
    await page.mouse.move(lorem.x + 60, lorem.y + 4)
    await page.mouse.down()
    await page.mouse.move(lorem.x + 160, lorem.y + 4, { steps: 5 })
    await page.mouse.up()
    await expect(inLine(page, 3)).toHaveCount(1)
    await expect(row(page, 'additions', 1)).not.toHaveAttribute('data-selected-line')
  })

  test('a drag from the end of a line starts on the next line with text', async ({
    page,
    repo,
  }) => {
    const title = (await row(page, 'additions', 1).boundingBox())!
    const lorem = (await row(page, 'additions', 3).boundingBox())!
    await page.mouse.move(title.x + title.width - 4, title.y + 4)
    await page.mouse.down()
    await page.mouse.move(lorem.x + 100, lorem.y + 4, { steps: 5 })
    await page.mouse.up()
    await textarea(page).fill('from the start')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({ lines: [3, 3] })
    expect((payload!['columns'] as number[])[0]).toBe(0)
  })

  test('a drag across sides in unified mode stays on the side it started on', async ({
    page,
    repo,
  }) => {
    await page.keyboard.press('s')
    const rows = page.locator('diffs-container [data-content] > [data-line]')
    const from = (await rows.filter({ hasText: 'old text' }).boundingBox())!
    const to = (await rows.filter({ hasText: 'Lorem' }).boundingBox())!
    await page.mouse.move(from.x + 20, from.y + 4)
    await page.mouse.down()
    await page.mouse.move(to.x + 60, to.y + 4, { steps: 5 })
    await page.mouse.up()
    await textarea(page).fill('from the old side')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    const [start, end] = payload!['columns'] as [number, number]
    expect(payload).toMatchObject({ side: 'deletions', lines: [3, 3] })
    expect(start).toBeGreaterThan(0)
    expect(end).toBe('old text'.length)
  })

  test('a drag across columns in split mode stays on the line it started on', async ({
    page,
    repo,
  }) => {
    const from = (await row(page, 'deletions', 3).boundingBox())!
    const to = (await row(page, 'additions', 3).boundingBox())!
    await page.mouse.move(from.x + 20, from.y + 4)
    await page.mouse.down()
    await page.mouse.move(to.x + 60, to.y + 4, { steps: 5 })
    await page.mouse.up()
    await textarea(page).fill('from the old side')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({ side: 'deletions', lines: [3, 3] })
    expect((payload!['columns'] as number[])[1]).toBe('old text'.length)
  })

  test('selecting an empty line comments on the line', async ({ page, repo }) => {
    // From the empty line to the start of the next, as a drag over it ends
    await row(page, 'additions', 3).evaluate((lorem) => {
      const empty = lorem.previousElementSibling!
      window.getSelection()!.setBaseAndExtent(empty, 0, lorem.firstChild!, 0)
      empty.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }))
    })
    await textarea(page).fill('empty line')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
    const [payload] = await sent(repo.dir)
    expect(payload).toMatchObject({ lines: [2, 2], columns: null })
  })

  test('a triple-click outside the code leaves the box in its line', async ({ page }) => {
    await row(page, 'additions', 3).dblclick({ position: { x: 24, y: 4 } })
    await expect(inLine(page, 3)).toHaveCount(1)
    await page.locator('code').filter({ hasText: 'git diff' }).click({ clickCount: 3 })
    await expect(inLine(page, 3)).toHaveCount(1)
    await expect(textarea(page)).toBeVisible()
  })

  test('an empty box closes on a click in the code; a draft stays', async ({ page }) => {
    await row(page, 'additions', 3).dblclick({ position: { x: 24, y: 4 } })
    await expect(textarea(page)).toBeFocused()
    await row(page, 'additions', 5).click()
    await expect(textarea(page)).toBeHidden()

    await row(page, 'additions', 3).dblclick({ position: { x: 24, y: 4 } })
    await textarea(page).fill('keep me')
    await row(page, 'additions', 1).dblclick({ position: { x: 24, y: 4 } })
    await row(page, 'additions', 5).click()
    await expect(textarea(page)).toHaveValue('keep me')
    await expect(inLine(page, 3)).toHaveCount(1)
  })

  test('⌘C copies the selection only while the box is empty', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (t: string) => void ((window as { copied?: string }).copied = t),
        },
      })
    })
    await page.reload()
    await row(page, 'additions', 3).dblclick({ position: { x: 24, y: 4 } })
    await expect(textarea(page)).toBeFocused()
    await page.keyboard.press('ControlOrMeta+c')
    expect(await page.evaluate(() => (window as { copied?: string }).copied)).toBe('Lorem')

    // With a draft, ⌘C and no text selected leaves the clipboard alone
    await page.evaluate(() => delete (window as { copied?: string }).copied)
    await textarea(page).fill('draft')
    await textarea(page).press('End')
    await page.keyboard.press('ControlOrMeta+c')
    expect(
      await page.evaluate(() => (window as { copied?: string }).copied),
    ).toBeUndefined()
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
