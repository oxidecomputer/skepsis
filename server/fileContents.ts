/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiffArgs, FileContentsResponse } from '../shared/types.ts'

/**
 * Run a command and return stdout, or null if it exits nonzero. A nonzero exit
 * is the normal signal that a path does not exist at a given revision (an added
 * or deleted file), so it's not treated as an error.
 */
function tryRun(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    const stdout: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', () => {})
    proc.on('error', reject)
    proc.on('close', (code) =>
      resolve(code === 0 ? Buffer.concat(stdout).toString() : null),
    )
  })
}

/** Fetch a file's contents at the diff's left revision. */
function fetchOld(src: DiffArgs, oldPath: string): Promise<string | null> {
  if (!src.endpoints) return Promise.resolve(null)
  const { left } = src.endpoints
  return src.vcs === 'jj'
    ? tryRun('jj', ['file', 'show', '-r', left, oldPath])
    : tryRun('git', ['show', `${left}:${oldPath}`])
}

/** Fetch a file's contents at the diff's right (new) endpoint. */
async function fetchNew(src: DiffArgs, path: string, cwd: string): Promise<string | null> {
  if (!src.endpoints) return null
  const { right } = src.endpoints
  if (right === 'workingCopy') {
    return readFile(join(cwd, path), 'utf-8').catch(() => null)
  }
  return src.vcs === 'jj'
    ? tryRun('jj', ['file', 'show', '-r', right.rev, path])
    : tryRun('git', ['show', `${right.rev}:${path}`])
}

/**
 * Full file contents at both diff endpoints, used by the client to build a
 * non-partial diff that supports hunk expansion. `oldPath` differs from `path`
 * for renamed files (the old-side path).
 */
export async function getFileContents(
  src: DiffArgs,
  cwd: string,
  path: string,
  oldPath?: string,
): Promise<FileContentsResponse> {
  const [oldContents, newContents] = await Promise.all([
    fetchOld(src, oldPath ?? path),
    fetchNew(src, path, cwd),
  ])
  return { oldContents, newContents }
}
