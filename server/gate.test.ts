/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { expect, test } from 'vitest'
import { newToken, sendGate, tokenMatches } from './gate.ts'

test('the page passes, other origins and hosts do not', () => {
  // The page, served directly or through Vite in --dev
  for (const host of ['localhost:5000', '127.0.0.1:5000', '[::1]:5000', 'localhost:5173']) {
    expect(sendGate({ host, origin: `http://${host}` })).toBe(true)
  }
  // curl, which sends no Origin
  expect(sendGate({ host: 'localhost:5000', origin: undefined })).toBe(true)
  // Another page on the same machine
  expect(sendGate({ host: 'localhost:5000', origin: 'http://localhost:8080' })).toBe(false)
  // A sandboxed iframe or file: page
  expect(sendGate({ host: 'localhost:5000', origin: 'null' })).toBe(false)
  // DNS rebinding: same-origin as far as the browser knows, but the wrong host
  expect(sendGate({ host: 'evil.test:5000', origin: 'http://evil.test:5000' })).toBe(false)
  expect(sendGate({ host: undefined, origin: undefined })).toBe(false)
})

test('only the run’s own token matches', () => {
  const token = newToken()
  expect(tokenMatches(token, token)).toBe(true)
  expect(tokenMatches(undefined, token)).toBe(false)
  expect(tokenMatches('', token)).toBe(false)
  expect(tokenMatches(token.slice(1), token)).toBe(false)
  expect(tokenMatches(newToken(), token)).toBe(false)
})
