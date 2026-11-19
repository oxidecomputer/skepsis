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
import { runSend } from './send.ts'
import type { SendPayload } from './send.ts'

/** The CLI's server: the app on its own port, with the guard on */
export async function startServer(
  opts: Omit<AppOptions, 'guard' | 'send'> & {
    port?: number
    hostname?: string
    /** The --send command. Unset, /api/send doesn't exist. */
    send?: string | null
  },
): Promise<{ port: number; token: string; close: () => void }> {
  const { port = 0, hostname = 'localhost', cwd, send: command } = opts
  // Known once listening; for SKEPSIS_URL.
  let serverUrl = ''
  const send = command
    ? (payload: SendPayload) => {
        const env = { SKEPSIS_URL: serverUrl, SKEPSIS_ROOT: cwd }
        return runSend(command, payload, { cwd, env })
      }
    : null
  const app = await buildApp({ ...opts, send })
  const token = app.token!

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
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
