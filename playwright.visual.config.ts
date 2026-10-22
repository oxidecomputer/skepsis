/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Visual comparison for dependency upgrades, not part of `npm run ci`. Take
 * baselines at the old revision with `npm run e2e:visual -- --update-snapshots`,
 * then run `npm run e2e:visual` at the new one and look at the diff images in
 * test-results/. Snapshots go in .visual/ (gitignored): font rendering differs
 * between machines, so committed baselines would never match CI. The spec also
 * writes a token dump per run; see e2e/visual/compareTokens.ts.
 */
export default {
  testDir: './e2e/visual',
  testMatch: /\.visual\.ts/,
  snapshotPathTemplate: '.visual/snapshots/{arg}{ext}',
  timeout: 60 * 1000,
  fullyParallel: true,
  reporter: 'list',
  expect: { toHaveScreenshot: { maxDiffPixels: 0 } },
  projects: [
    {
      name: 'chrome',
      use: {
        contextOptions: { reducedMotion: 'reduce' },
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        deviceScaleFactor: 1,
      },
    },
  ],
} satisfies PlaywrightTestConfig
