/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Per-file attributes that affect how skepsis displays a file in the diff.
 * Mirrors GitHub Linguist: `linguist-generated`, `linguist-vendored`,
 * `linguist-documentation`, and `binary`. Sources (highest priority first):
 *
 *   1. `.gitattributes` via `git check-attr` — explicit `set`/`unset`.
 *   2. Linguist's built-in path rules (`linguist/pathRules.ts`).
 *
 * Generated/vendored/binary files are auto-collapsed by the frontend;
 * documentation files get a badge but stay expanded.
 */

import { spawn } from 'node:child_process'
import type { FileAttrs, FileHashes } from '../shared/types.ts'
import { classifyByPaths } from './linguist/pathRules.ts'
import { classifyByContent } from './linguist/contentRules.ts'
import { readBlobSummaries } from './linguist/contentReader.ts'

/**
 * A `Partial<FileAttrs>` tracks which attributes a layer has decided on.
 * A missing key means "no opinion" — the next layer gets a turn.
 */
export type PartialAttrMap = Record<string, Partial<FileAttrs>>

const TRACKED_ATTRS = [
  'linguist-generated',
  'linguist-vendored',
  'linguist-documentation',
  'binary',
] as const

type TrackedAttr = (typeof TRACKED_ATTRS)[number]

/**
 * Resolve the full attribute map for a diff by combining (highest priority
 * first):
 *
 *   1. `.gitattributes` via `git check-attr`.
 *   2. Linguist's built-in path rules.
 *   3. Linguist's built-in content rules (reads blob contents via
 *      `git cat-file`; only runs where `generated` isn't already decided).
 *
 * Files without any set attribute are omitted from the result.
 */
export async function resolveFileAttrs(
  fileHashes: FileHashes,
  cwd: string,
): Promise<Record<string, FileAttrs>> {
  const files = Object.keys(fileHashes)
  if (files.length === 0) return {}

  const [gitAttrs, pathAttrs] = await Promise.all([
    getGitAttrs(files, cwd),
    Promise.resolve(classifyByPaths(files)),
  ])

  // Only read content for files whose `generated` status isn't already
  // decided. check-attr `unset` wins — we respect the user's override and
  // skip content checks.
  const needsContent: FileHashes = {}
  for (const [path, hash] of Object.entries(fileHashes)) {
    const git = gitAttrs[path]?.generated
    const byPath = pathAttrs[path]?.generated
    if (git === undefined && byPath !== true) needsContent[path] = hash
  }

  const contentAttrs: PartialAttrMap = {}
  if (Object.keys(needsContent).length > 0) {
    const summaries = await readBlobSummaries(needsContent, cwd)
    for (const [path, summary] of Object.entries(summaries)) {
      const attrs = classifyByContent(path, summary)
      if (Object.keys(attrs).length > 0) contentAttrs[path] = attrs
    }
  }

  return mergeAttrs([gitAttrs, pathAttrs, contentAttrs])
}

/**
 * Fetch `.gitattributes` attributes for the given file paths. Presence of
 * a key in the inner `Partial<FileAttrs>` means check-attr returned
 * `set` or `unset` for that attribute; `unspecified` is represented as a
 * missing key so lower-priority layers can contribute.
 *
 * Resolves to `{}` if `git check-attr` is unavailable (e.g., pure-jj repo
 * with no `.git/`).
 */
export async function getGitAttrs(files: string[], cwd: string): Promise<PartialAttrMap> {
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
 * `unspecified` is dropped so lower-priority sources can contribute.
 */
export function parseCheckAttrOutput(stdout: string): PartialAttrMap {
  const result: PartialAttrMap = {}

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
    if (value !== 'set' && value !== 'unset') continue

    const attrs = (result[path] ??= {})
    attrs[ATTR_TO_FIELD[attr]] = value === 'set'
  }

  return result
}

/**
 * Merge attribute layers in priority order (first wins per attribute).
 * Materializes to full `FileAttrs` objects and drops entries where
 * nothing ended up set.
 */
export function mergeAttrs(layers: PartialAttrMap[]): Record<string, FileAttrs> {
  const paths = new Set<string>()
  for (const layer of layers) {
    for (const path of Object.keys(layer)) paths.add(path)
  }

  const result: Record<string, FileAttrs> = {}
  const fields: (keyof FileAttrs)[] = ['generated', 'vendored', 'documentation', 'binary']

  for (const path of paths) {
    const out: FileAttrs = {
      generated: false,
      vendored: false,
      documentation: false,
      binary: false,
    }
    for (const field of fields) {
      for (const layer of layers) {
        const v = layer[path]?.[field]
        if (v !== undefined) {
          out[field] = v
          break
        }
      }
    }
    if (out.generated || out.vendored || out.documentation || out.binary) {
      result[path] = out
    }
  }

  return result
}

function isTrackedAttr(s: string): s is TrackedAttr {
  return (TRACKED_ATTRS as readonly string[]).includes(s)
}
