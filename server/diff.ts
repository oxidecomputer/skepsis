/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { DiffArgs, FileHashes } from '../shared/types.ts'

function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', (d) => stderr.push(d))
    proc.on('error', reject)
    proc.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        code: code ?? 1,
      }),
    )
  })
}

/*
 * Force canonical `a/`…`b/` path prefixes in the git-format diff, overriding
 * any user config. Both parsers downstream (@pierre/diffs on the client and
 * extractFileHashes below) only understand `a/`/`b/` headers; git's
 * diff.mnemonicPrefix (c/ i/ w/ o/) or diff.srcPrefix/dstPrefix/noPrefix would
 * otherwise yield unparseable headers, blank file names, and a duplicate-id
 * crash in CodeView. These are passed as one-shot -c/--config flags so the
 * user's own config is untouched.
 */
const GIT_PREFIX_OVERRIDE = [
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.srcPrefix=a/',
  '-c',
  'diff.dstPrefix=b/',
]
const JJ_PREFIX_OVERRIDE = ['--config', 'diff.git.show-path-prefix=true']

export function diffCommand(src: DiffArgs): { cmd: string; args: string[] } {
  const fileArgs = src.files.length > 0 ? ['--', ...src.files] : []
  if (src.vcs === 'jj') {
    return {
      cmd: 'jj',
      args: [...JJ_PREFIX_OVERRIDE, 'diff', ...src.args, '--git', ...fileArgs],
    }
  } else {
    return {
      cmd: 'git',
      args: [...GIT_PREFIX_OVERRIDE, 'diff', ...src.args, ...fileArgs],
    }
  }
}

/**
 * jj's git-format diff writes "rename from/to" without git's "similarity
 * index" line, and @pierre/diffs only treats a git diff block as a rename
 * when it has one. Otherwise the rename parses as a plain change to the new
 * path and loses the old name. Insert the line before "rename from". jj
 * doesn't compute similarity, and the parser only distinguishes 100% (pure
 * rename) from anything else, so a block with an index line (content
 * changed) gets an arbitrary 50%.
 */
export function normalizeJjRenames(patch: string): string {
  const lines = patch.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('rename from ') && !out.at(-1)?.startsWith('similarity index ')) {
      let contentChanged = false
      // Extended header lines run until the --- line, a hunk, or the next file.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!
        if (
          next.startsWith('diff --git ') ||
          next.startsWith('--- ') ||
          next.startsWith('@@')
        ) {
          break
        }
        if (next.startsWith('index ')) contentChanged = true
      }
      out.push(`similarity index ${contentChanged ? 50 : 100}%`)
    }
    out.push(line)
  }
  return out.join('\n')
}

export async function getDiff(
  src: DiffArgs,
): Promise<{ patch: string; fileHashes: FileHashes }> {
  const { cmd, args } = diffCommand(src)
  const { stdout, stderr, code } = await run(cmd, args)
  if (code !== 0) {
    throw new Error(`${cmd} diff failed (exit ${code}): ${stderr}`)
  }
  const patch = src.vcs === 'jj' ? normalizeJjRenames(stdout) : stdout
  return { patch, fileHashes: extractFileHashes(patch) }
}

/**
 * Extract newObjectId per file from the git diff's index lines.
 * Format: "diff --git a/<path> b/<path>" followed by "index <old>..<new> <mode>".
 * The a//b/ prefixes are guaranteed by GIT_PREFIX_OVERRIDE / JJ_PREFIX_OVERRIDE
 * regardless of the user's diff config, and must match the names @pierre/diffs
 * parses on the client so viewed-state keys line up.
 *
 * Pure renames and mode-only changes have no index line, so they get a hash
 * of their extended header lines instead. That changes when the rename or
 * mode does, and a content change adds an index line, so viewed state still
 * resets whenever there is something new to look at.
 */
export function extractFileHashes(patch: string): FileHashes {
  const hashes: FileHashes = {}
  let currentFile: string | null = null
  let header: string[] = []

  const finishHeaderOnly = () => {
    if (currentFile == null) return
    hashes[currentFile] = createHash('sha1')
      .update(header.join('\n'))
      .digest('hex')
      .slice(0, 12)
  }

  for (const line of patch.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (diffMatch) {
      finishHeaderOnly()
      currentFile = diffMatch[1]!
      header = [line]
      continue
    }
    if (currentFile == null) continue
    if (line.startsWith('index ')) {
      const indexMatch = line.match(/^index [0-9a-f]+\.\.([0-9a-f]+)/)
      if (indexMatch) {
        hashes[currentFile] = indexMatch[1]!
      }
      currentFile = null
    } else {
      header.push(line)
    }
  }
  finishHeaderOnly()

  return hashes
}
