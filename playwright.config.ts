/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * See https://playwright.dev/docs/test-configuration. Each test boots its own
 * server against its own temp repo (see e2e/fixtures.ts), so there is no
 * shared webServer here — but the server serves the built UI from dist/web,
 * so run `npm run build` first.
 */
export default {
  testDir: './e2e',
  testMatch: /\.e2e\.ts/,
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: (process.env.CI ? 60 : 30) * 1000,
  fullyParallel: true,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: {
        contextOptions: { reducedMotion: 'reduce' },
        ...devices['Desktop Chrome'],
        channel: 'chromium',
      },
    },
  ],
} satisfies PlaywrightTestConfig
