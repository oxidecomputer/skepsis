/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { defineConfig } from 'tsdown'

// Both outputs go directly in dist/, which the server's path to dist/web
// depends on (see distDir in server/app.ts).
const common = {
  outDir: 'dist',
  clean: false,
  outExtensions: () => ({ js: '.js' }),
}

export default defineConfig([
  { ...common, entry: ['cli.ts'], dts: false },
  {
    ...common,
    entry: ['lib.ts'],
    dts: true,
    inputOptions: {
      // The dts build reads zod's declarations, since shared/types.ts imports
      // it, and warns about each CommonJS one. None of zod's types end up in
      // lib.d.ts. (Marking zod external instead leaves an `import "zod"`.)
      onLog(level, log, handler) {
        if (log.plugin === 'rolldown-plugin-dts:fake-js' && log.message.includes('/zod/'))
          return
        handler(level, log)
      },
    },
  },
])
