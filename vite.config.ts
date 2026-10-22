/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const rawApiHost = process.env['API_HOST'] || 'localhost'
// 0.0.0.0 means "bind to all interfaces" and isn't reliably dialable as a
// connect target on macOS/Windows, so route the proxy at localhost instead.
const apiHost = rawApiHost === '0.0.0.0' ? 'localhost' : rawApiHost
const apiPort = process.env['API_PORT'] || 3742

export default defineConfig({
  plugins: [react()],
  test: {
    // The server tests mutate per-process global state (isolateVcsConfig
    // rewrites process.env, main.test.ts chdirs into its temp repo), so each
    // test file needs its own process. Forks is already the default pool;
    // pinned because switching to threads would break that isolation, and
    // worker threads can't chdir anyway.
    pool: 'forks',
    // Hide console output from passing tests — the server integration tests
    // log the server URL and a serveStatic warning about the missing dist/web.
    // Output is still shown for failing tests.
    silent: 'passed-only',
  },
  build: {
    outDir: 'dist/web',
  },
  // The highlighter worker loads languages and themes with dynamic imports.
  // The default IIFE format can't code-split, so it would inline every one
  // of them (11 MB); ES module workers keep them as lazy chunks.
  worker: { format: 'es' },
  server: {
    proxy: {
      // changeOrigin off (the string shorthand turns it on) so the API sees
      // the page's own Host, which /api/send's gate compares with Origin.
      '/api': { target: `http://${apiHost}:${apiPort}`, changeOrigin: false },
    },
  },
})
