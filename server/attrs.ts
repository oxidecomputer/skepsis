/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Per-file attributes that affect how skepsis displays a file in the diff.
 * Sourced from `.gitattributes` via `git check-attr`, mirroring GitHub
 * Linguist's behavior for `linguist-generated`, `linguist-vendored`,
 * `linguist-documentation`, and `binary`.
 *
 * Generated/vendored/binary files are auto-collapsed by the frontend;
 * documentation files get a badge but stay expanded.
 */

import { spawn } from 'node:child_process'
import type { FileAttrs } from '../shared/types.ts'

const TRACKED_ATTRS = [
  'linguist-generated',
  'linguist-vendored',
  'linguist-documentation',
  'binary',
] as const

type TrackedAttr = (typeof TRACKED_ATTRS)[number]

function emptyAttrs(): FileAttrs {
  return {
    generated: false,
    vendored: false,
    documentation: false,
    binary: false,
  }
}

/**
 * Fetch `.gitattributes` attributes for the given file paths. Returns a
 * partial map: files with no tracked attributes set are omitted.
 *
 * Resolves to `{}` if `git check-attr` is unavailable (e.g., pure-jj repo
 * with no `.git/`) — skepsis treats that as "no files have attributes."
 */
export async function getGitAttrs(
  files: string[],
  cwd: string,
): Promise<Record<string, FileAttrs>> {
  if (files.length === 0) return {}

  let stdout: string
  try {
    stdout = await runCheckAttr(files, cwd)
  } catch {
    return {}
  }
  return parseCheckAttrOutput(stdout)
}

function runCheckAttr(files: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['check-attr', '--stdin', ...TRACKED_ATTRS], {
      cwd,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d))
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString())
      } else {
        reject(
          new Error(
            `git check-attr exited ${code}: ${Buffer.concat(stderrChunks).toString()}`,
          ),
        )
      }
    })
    proc.stdin.end(files.join('\n') + '\n')
  })
}

const ATTR_TO_FIELD: Record<TrackedAttr, keyof FileAttrs> = {
  'linguist-generated': 'generated',
  'linguist-vendored': 'vendored',
  'linguist-documentation': 'documentation',
  binary: 'binary',
}

/**
 * Parse `git check-attr --stdin` output. Format per line:
 *   <path>: <attr>: <value>
 * where value is `set`, `unset`, `unspecified`, or a literal string.
 * Only `set` counts as true for our boolean attributes.
 */
export function parseCheckAttrOutput(stdout: string): Record<string, FileAttrs> {
  const result: Record<string, FileAttrs> = {}

  for (const line of stdout.split('\n')) {
    if (!line) continue

    // Parse "path: attr: value" from the right, since paths may contain colons.
    const lastColon = line.lastIndexOf(': ')
    if (lastColon === -1) continue
    const value = line.slice(lastColon + 2)
    const pathAndAttr = line.slice(0, lastColon)

    const midColon = pathAndAttr.lastIndexOf(': ')
    if (midColon === -1) continue
    const path = pathAndAttr.slice(0, midColon)
    const attr = pathAndAttr.slice(midColon + 2)

    if (!isTrackedAttr(attr)) continue

    const attrs = (result[path] ??= emptyAttrs())
    attrs[ATTR_TO_FIELD[attr]] = value === 'set'
  }

  // Drop entries where nothing was set — keeps the payload small.
  for (const [path, attrs] of Object.entries(result)) {
    if (!attrs.generated && !attrs.vendored && !attrs.documentation && !attrs.binary) {
      delete result[path]
    }
  }

  return result
}

function isTrackedAttr(s: string): s is TrackedAttr {
  return (TRACKED_ATTRS as readonly string[]).includes(s)
}
