/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Read blob contents from the git object store in one batched subprocess,
 * then summarize each blob as line arrays for the content-based Linguist
 * rules.
 *
 * We use the blob object IDs that skepsis already extracts from the diff
 * (the "newObjectId" side). Deleted files (all-zero hash) are skipped,
 * and blobs that git reports as missing are silently omitted — the
 * caller treats them as "no content signal."
 */

import { spawn } from 'node:child_process'

export interface BlobSummary {
  /** All lines of the blob (split on \n — trailing empty string preserved). */
  lines: string[]
}

export async function readBlobSummaries(
  blobIdsByPath: Record<string, string>,
  cwd: string,
): Promise<Record<string, BlobSummary>> {
  const uniqueIds = new Set<string>()
  for (const id of Object.values(blobIdsByPath)) {
    if (id && !/^0+$/.test(id)) uniqueIds.add(id)
  }
  if (uniqueIds.size === 0) return {}

  let blobs: Map<string, string>
  try {
    blobs = await readBlobs([...uniqueIds], cwd)
  } catch {
    return {}
  }

  const result: Record<string, BlobSummary> = {}
  for (const [path, id] of Object.entries(blobIdsByPath)) {
    const content = blobs.get(id)
    if (content === undefined) continue
    result[path] = { lines: content.split('\n') }
  }
  return result
}

function readBlobs(blobIds: string[], cwd: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['cat-file', '--batch', '--buffer'], { cwd })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d))
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git cat-file exited ${code}: ${Buffer.concat(stderrChunks).toString()}`,
          ),
        )
        return
      }
      try {
        resolve(parseCatFileBatch(Buffer.concat(stdoutChunks)))
      } catch (e) {
        reject(e)
      }
    })
    proc.stdin.end(blobIds.join('\n') + '\n')
  })
}

/**
 * Parse `git cat-file --batch` output. For each requested object id, git
 * emits either:
 *   <sha> missing\n
 * or:
 *   <sha> <type> <size>\n
 *   <size bytes of content>\n
 *
 * Exported for tests.
 */
export function parseCatFileBatch(buf: Buffer): Map<string, string> {
  const result = new Map<string, string>()
  const LF = 0x0a
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf(LF, i)
    if (nl === -1) break
    const header = buf.slice(i, nl).toString('utf-8')
    i = nl + 1
    const parts = header.split(' ')
    const sha = parts[0]
    if (!sha) break
    if (parts[1] === 'missing') continue
    const size = Number(parts[2])
    if (!Number.isFinite(size) || size < 0) break
    if (i + size > buf.length) break
    const content = buf.slice(i, i + size).toString('utf-8')
    result.set(sha, content)
    i += size
    // Skip the trailing LF after the content, if present.
    if (buf[i] === LF) i += 1
  }
  return result
}
