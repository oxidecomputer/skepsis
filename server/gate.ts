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

import { randomBytes, timingSafeEqual } from 'node:crypto'

export interface GateHeaders {
  host: string | undefined
  origin: string | undefined
}

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A fresh secret for one run of the server. */
export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Whether a request's token header matches the run's token. Every API request
 * must carry it, so only a page opened from the URL skepsis printed can use
 * the API. Unlike the checks in sendGate, this doesn't depend on how the
 * request reached the port, so it also keeps out anything coming in through a
 * forwarded port. It doesn't keep out other users on this machine, who can
 * see the URL in a browser's argv on Linux, or processes running as you.
 */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function sendGate({ host, origin }: GateHeaders): boolean {
  if (!host || !LOOPBACK.has(host.replace(/:\d+$/, ''))) return false
  return !origin || origin === `http://${host}`
}
