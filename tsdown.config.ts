/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['cli.ts'],
  outDir: 'dist',
  clean: false,
  dts: false,
  outExtensions: () => ({ js: '.js' }),
})
