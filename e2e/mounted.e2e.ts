/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startNode } from '../server/testUtil.ts'
import { browserTest as test, COMMITTED, expect, makeRepo, WORKING } from './fixtures.ts'

const PREFIX = '/some/prefix'
const HOST = join(import.meta.dirname, 'mountHost.ts')

/** The page as another application serves it, from createApp under PREFIX.
 *  `guard` leaves skepsis's guard on, and `host.url` then has the token */
const mounted = test.extend<{
  guard: boolean
  host: { dir: string; url: string; log: () => string }
}>({
  guard: [false, { option: true }],
  host: async ({ guard }, provide) => {
    const { dir, home, env } = await makeRepo({ committed: COMMITTED, working: WORKING })
    const settings = join(home, '.local', 'share', 'skepsis')
    await mkdir(settings, { recursive: true })
    await writeFile(join(settings, 'settings.json'), JSON.stringify({ theme: 'dark' }))

    const {
      proc,
      match: url,
      output,
    } = await startNode(
      HOST,
      guard ? [PREFIX, 'guard'] : [PREFIX],
      dir,
      /host on (\S+)/,
      env,
    )
    await provide({ dir, url, log: output })

    proc.kill()
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  },
})

mounted.use({ colorScheme: 'light' })

mounted('the page works under a prefix', async ({ page, host }) => {
  const requests: string[] = []
  page.on('request', (r) => requests.push(new URL(r.url()).pathname))
  await page.goto(host.url)

  await expect(page.locator('.file-header-name')).toHaveText(['a.ts', 'b.txt'])
  // The boot script loaded: the stored theme beats the OS's light
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // The highlighter worker loaded
  await expect(
    page.locator('diffs-container').first().locator('[style*="--diffs-token"]').first(),
  ).toBeAttached()

  await page.keyboard.press('j')
  await page.keyboard.press('c')
  const textarea = page.getByPlaceholder('Leave a review comment')
  await expect(textarea).toBeFocused()
  await textarea.fill('from the host')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Sent', { exact: true })).toBeVisible()
  const sent = await readFile(join(host.dir, '.git', 'sent.jsonl'), 'utf8')
  expect(JSON.parse(sent)).toMatchObject({ file: 'a.ts', text: 'from the host' })

  const viewed = page.locator('.viewed-button').first()
  await viewed.click()
  await expect(viewed).toHaveClass(/checked/)
  await page.reload()
  await expect(page.locator('.viewed-button').first()).toHaveClass(/checked/)

  // A path with no file is a 404, not the page, whose relative URLs would
  // point at the wrong place from there
  expect((await page.request.get(`${host.url}no/such/page`)).status()).toBe(404)

  // The browser asks for /favicon.ico on its own; the page has no icon.
  const outside = (path: string) =>
    !path.startsWith(`${PREFIX}/`) && path !== '/favicon.ico'
  expect(requests.filter(outside)).toEqual([])
  // Including requests the page doesn't see, such as the worker's own imports
  const notFound = [...host.log().matchAll(/^404 (\S+)$/gm)].map((m) => m[1]!)
  expect(notFound.filter(outside)).toEqual([])
})

mounted.describe('with the guard on', () => {
  mounted.use({ guard: true })

  mounted('the page works from the URL with the token', async ({ page, host }) => {
    await page.goto(host.url)
    await expect(page.locator('.file-header-name')).toHaveText(['a.ts', 'b.txt'])
    // The token is stored for this path, so the bare URL works afterwards
    await expect(page).toHaveURL(new URL(host.url).origin + `${PREFIX}/`)
    await page.reload()
    await expect(page.locator('.file-header-name')).toHaveText(['a.ts', 'b.txt'])

    // Send passes the Host and Origin check, since the host is on loopback
    await page.keyboard.press('j')
    await page.keyboard.press('c')
    const textarea = page.getByPlaceholder('Leave a review comment')
    await textarea.fill('past the guard')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Sent', { exact: true })).toBeVisible()
  })

  mounted('the API turns away a request without the token', async ({ page, host }) => {
    const res = await page.request.get(new URL('api/diff', host.url).href)
    expect(res.status()).toBe(401)
  })
})
