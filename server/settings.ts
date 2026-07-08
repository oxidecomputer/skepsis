/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Global UI settings at ~/.local/share/skepsis/settings.json. Unlike viewed
 * state, settings are not per-repo (no cwd hashing): a theme preference is
 * about the user, not the diff under review. Server-side storage is what
 * makes the preference survive restarts at all — the ephemeral port means a
 * fresh browser origin every run, so web storage can't.
 */

import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { THEME_MODES } from '../shared/types.ts'
import type { ThemeMode } from '../shared/types.ts'

const BASE_DIR = join(process.env['HOME'] ?? '~', '.local', 'share', 'skepsis')
const SETTINGS_PATH = join(BASE_DIR, 'settings.json')

/** Missing file, unparseable JSON, or an unknown value → 'system'. */
export async function loadTheme(): Promise<ThemeMode> {
  try {
    const raw: unknown = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
    const theme = (raw as { theme?: unknown }).theme
    if ((THEME_MODES as readonly unknown[]).includes(theme)) return theme as ThemeMode
  } catch {
    // fall through to the default
  }
  return 'system'
}

export async function saveTheme(theme: ThemeMode): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true })
  await writeFile(SETTINGS_PATH, JSON.stringify({ theme }, null, 2) + '\n')
}

/** Body of /api/theme.js, loaded by a render-blocking <script> in index.html
 *  so a forced theme's data-theme lands on <html> before first paint (CSS
 *  keys color-scheme off the attribute). 'system' means no attribute: an
 *  empty script leaves the page following the OS. */
export function themeBootScript(theme: ThemeMode): string {
  if (theme === 'system') return ''
  return `document.documentElement.dataset.theme = '${theme}'\n`
}
