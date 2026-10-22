/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures.ts'

// Each step drives the page and depends on the one before it.
/* oxlint-disable no-await-in-loop */

// Screenshots and a token dump for comparing two builds of the page. See
// playwright.visual.config.ts for the workflow.

const SAMPLES_DIR = join(import.meta.dirname, 'samples')
const OUT_DIR = join(import.meta.dirname, '..', '..', '.visual')

// Samples are stored with a .txt suffix so the repo's formatter, linter and
// license check leave them alone.
async function loadSamples(): Promise<Record<string, string>> {
  const names = (await readdir(SAMPLES_DIR)).filter((n) => n.endsWith('.txt')).toSorted()
  const entries = await Promise.all(
    names.map(async (n) => [n.slice(0, -4), await readFile(join(SAMPLES_DIR, n), 'utf8')]),
  )
  return Object.fromEntries(entries)
}

const samples = await loadSamples()
const sampleNames = Object.keys(samples)

const scroller = (page: Page) => page.locator('.codeview-root')

/** Every rendered line of every rendered file, as [file, line, runs]. A run
 *  is a token's text plus its style attribute, which carries both themes'
 *  colors as custom properties. */
function collectLines(page: Page) {
  return page.evaluate(() => {
    const out: [string, string, [string, string][]][] = []
    for (const container of document.querySelectorAll('diffs-container')) {
      const file = container.querySelector('.file-header-name')?.textContent ?? '?'
      const root = container.shadowRoot
      if (!root) continue
      for (const line of root.querySelectorAll<HTMLElement>('code [data-line]')) {
        const side = line.closest('code')?.hasAttribute('data-deletions') ? 'old' : 'new'
        const runs: [string, string][] = []
        for (const span of line.querySelectorAll<HTMLElement>(':scope > span')) {
          const style = span.getAttribute('style') ?? ''
          const last = runs.at(-1)
          if (last && last[1] === style) last[0] += span.textContent
          else runs.push([span.textContent ?? '', style])
        }
        out.push([file, `${side}:${line.dataset['line']}`, runs])
      }
    }
    return out
  })
}

test.describe('languages', () => {
  test.use({ repoFiles: { committed: {}, working: samples } })

  // Each file is new, so the whole sample is one hunk of additions.
  for (const scheme of ['light', 'dark'] as const) {
    for (const [style, width] of [
      ['unified', 1000],
      ['split', 1440],
    ] as const) {
      test(`${scheme} ${style}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme })
        await page.setViewportSize({ width, height: 1800 })
        await page.locator('.file-header').first().waitFor()
        // The page's file order isn't a plain sort, so follow `n` and name
        // each shot after the file it lands on.
        const focused = page.locator('.file-header.focused .file-header-name')
        let prev = ''
        for (let i = 0; i < sampleNames.length; i++) {
          if (i > 0) await page.keyboard.press('n')
          await expect(focused).not.toHaveText(prev)
          const name = (await focused.textContent())!
          await expect.soft(page).toHaveScreenshot(`lang-${scheme}-${style}-${name}.png`)
          prev = name
        }
      })
    }
  }

  // Not a comparison by itself: writes .visual/tokens-<label>.json for
  // compareTokens.ts. VISUAL_LABEL names the build (e.g. shiki-1.5.1).
  test('token dump', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1200 })
    await page.locator('.file-header').first().waitFor()
    const lines = new Map<string, [string, string][]>()
    let lastTop = -1
    for (;;) {
      // Let the worker pool's highlighting land before reading.
      await page.waitForTimeout(400)
      for (const [file, line, runs] of await collectLines(page)) {
        lines.set(`${file}\t${line}`, runs)
      }
      const top = await scroller(page).evaluate((el) => {
        el.scrollBy(0, el.clientHeight * 0.8)
        return el.scrollTop
      })
      if (top === lastTop) break
      lastTop = top
    }
    const byFile: Record<string, Record<string, [string, string][]>> = {}
    for (const [key, runs] of lines) {
      const [file, line] = key.split('\t') as [string, string]
      ;(byFile[file] ??= {})[line] = runs
    }
    expect(Object.keys(byFile).toSorted()).toEqual(sampleNames)
    await mkdir(OUT_DIR, { recursive: true })
    const label = process.env['VISUAL_LABEL'] ?? 'current'
    await writeFile(join(OUT_DIR, `tokens-${label}.json`), JSON.stringify(byFile, null, 1))
  })
})

// A long file with two edited regions, so there's collapsed context between
// them to expand.
const RS = samples['sample.rs']!
const RS_COMMITTED = RS.replace('use std::fmt;\n', '')
  .replace(
    'Self::Stopped => f.write_str("stopped")',
    'Self::Stopped => write!(f, "stopped")',
  )
  .replace("let ch = '\\n';\n", "let ch = 'x';\n")
const TS = samples['sample.ts']!
const TS_COMMITTED = TS.replace('const MAX_BYTES = 64 * 1024', 'const MAX_BYTES = 1024')

test.describe('layout', () => {
  test.use({
    repoFiles: {
      committed: { 'sample.rs': RS_COMMITTED, 'sample.ts': TS_COMMITTED },
      working: { 'sample.rs': RS, 'sample.ts': TS, 'notes.txt': 'new file\n' },
    },
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(scheme, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1440, height: 1000 })
      const shot = (name: string) =>
        expect.soft(page).toHaveScreenshot(`layout-${scheme}-${name}.png`)
      const rs = page.locator('diffs-container').filter({
        has: page.locator('.file-header-name').getByText('sample.rs', { exact: true }),
      })
      await rs.locator('.file-header').waitFor()
      await shot('initial')

      // Viewed collapses the file; the next file's card moves up under it.
      await rs.locator('.viewed-button').click()
      await shot('collapsed')
      await rs.locator('.viewed-button').click()

      await rs.locator('[data-expand-button]:visible').first().click()
      await shot('expanded')

      // The comment form on the focused line, then the review block it writes.
      await page.keyboard.press('j')
      await page.keyboard.press('c')
      await page.locator('textarea').fill('A review comment')
      await shot('comment-form')
      await page.getByRole('button', { name: 'Comment', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Resolve comment' })).toBeVisible()
      await shot('review')

      await scroller(page).evaluate((el) => el.scrollBy(0, 700))
      await shot('scrolled')
    })
  }
})
