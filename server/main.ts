/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { serve } from '@hono/node-server'
import { buildApp } from './app.ts'
import type { AppOptions } from './app.ts'
import { displayCommand } from './displayCommand.ts'

export async function startServer(
  opts: AppOptions & { port?: number; hostname?: string },
): Promise<{ port: number; token: string; close: () => void }> {
  const { port = 0, hostname = 'localhost' } = opts
  // Known once listening; for SKEPSIS_URL.
  let serverUrl = ''
  const { fetch, token } = await buildApp(opts, () => serverUrl)

  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname }, (info) => {
      const assignedPort = typeof info === 'string' ? port : info.port
      serverUrl = `http://${hostname}:${assignedPort}`
      console.info(
        `skepsis on ${serverUrl}/#token=${token} (${displayCommand(opts.diffSource)})`,
      )
      resolve({ port: assignedPort, token, close: () => server.close() })
    })
    server.on('error', reject)
  })
}
