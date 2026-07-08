/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rawApiHost = process.env['API_HOST'] || 'localhost'
// 0.0.0.0 means "bind to all interfaces" and isn't reliably dialable as a
// connect target on macOS/Windows, so route the proxy at localhost instead.
const apiHost = rawApiHost === '0.0.0.0' ? 'localhost' : rawApiHost
const apiPort = process.env['API_PORT'] || 3742

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    // Vite's default cssTarget predates light-dark(), so esbuild lowers it
    // to a prefers-color-scheme polyfill that follows the OS and ignores the
    // forced color-scheme --theme sets. Target the first versions with
    // light-dark() support so it ships untransformed. Not a new floor in
    // practice: the diff library already emits light-dark() at runtime.
    cssTarget: ['chrome123', 'firefox120', 'safari17.5'],
  },
  server: {
    proxy: {
      '/api': `http://${apiHost}:${apiPort}`,
    },
  },
})
