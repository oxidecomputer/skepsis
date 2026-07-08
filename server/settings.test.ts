/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// Type-only, so it doesn't evaluate the module before HOME is stubbed.
import type * as SettingsModule from './settings.ts'

// The module derives its storage path from HOME at import time, so stub HOME
// and import dynamically instead of statically.
let home: string
let settings: typeof SettingsModule

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'skepsis-settings-'))
  vi.stubEnv('HOME', home)
  settings = await import('./settings.ts')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('loadTheme/saveTheme', () => {
  it('defaults to system when the file is missing', async () => {
    expect(await settings.loadTheme()).toBe('system')
  })

  it('round-trips a saved theme', async () => {
    await settings.saveTheme('light')
    expect(await settings.loadTheme()).toBe('light')
    await settings.saveTheme('system')
    expect(await settings.loadTheme()).toBe('system')
  })

  it('falls back to system on garbage', async () => {
    const path = join(home, '.local', 'share', 'skepsis', 'settings.json')
    await mkdir(join(home, '.local', 'share', 'skepsis'), { recursive: true })
    await writeFile(path, 'not json')
    expect(await settings.loadTheme()).toBe('system')
    await writeFile(path, JSON.stringify({ theme: 'mauve' }))
    expect(await settings.loadTheme()).toBe('system')
  })
})

describe('themeBootScript', () => {
  it('stamps a forced theme onto the html element', () => {
    expect(settings.themeBootScript('light')).toBe(
      "document.documentElement.dataset.theme = 'light'\n",
    )
    expect(settings.themeBootScript('dark')).toBe(
      "document.documentElement.dataset.theme = 'dark'\n",
    )
  })

  it('is empty for system', () => {
    expect(settings.themeBootScript('system')).toBe('')
  })
})
