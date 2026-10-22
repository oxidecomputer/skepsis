/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Which requests /api/send takes: the page itself, nothing else. Posting to
 * it runs the --send command with text from the request, so a page on
 * another origin must not be able to. The Host check blocks DNS rebinding.
 * Origin keeps out other origins' pages: browsers send it on every
 * cross-origin POST, no-cors and form posts included, so Sec-Fetch-Site would
 * add nothing.
 *
 * Any port passes, since in --dev the page is on Vite's port and the proxy
 * forwards its Host. Only loopback names pass, since --send refuses to start
 * with any other --host.
 */

export interface GateHeaders {
  host: string | undefined
  origin: string | undefined
}

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function sendGate({ host, origin }: GateHeaders): boolean {
  if (!host || !LOOPBACK.has(host.replace(/:\d+$/, ''))) return false
  return !origin || origin === `http://${host}`
}
