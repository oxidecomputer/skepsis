/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { basename } from 'node:path'

/** Lockfiles count as generated unless the repo says otherwise. */
const LOCKFILES = new Set([
  'Cargo.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'flake.lock',
])

/**
 * The files among `files` that are generated, which the page starts
 * collapsed, as GitHub does. The `linguist-generated` git attribute decides
 * whenever it's set or unset; otherwise only lockfiles count. git reads the
 * attribute from .gitattributes, .git/info/attributes, and
 * core.attributesFile, so patterns don't have to be checked in. Without git
 * (a jj repo with no colocated .git), only the lockfile rule applies.
 */
export async function getGeneratedFiles(cwd: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return []
  const attrs = await checkAttr(cwd, files).catch(() => new Map<string, string>())
  return files.filter((file) => {
    const value = attrs.get(file)
    if (value === 'set' || value === 'true') return true
    if (value === 'unset' || value === 'false') return false
    return LOCKFILES.has(basename(file))
  })
}

/** Each file's `linguist-generated` value: set, unset, unspecified, or the
 *  string it's set to (e.g. `true` for `linguist-generated=true`). */
function checkAttr(cwd: string, files: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['check-attr', '-z', '--stdin', 'linguist-generated'], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const stdout: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.on('error', reject)
    // Outside a git repo, git exits before reading stdin.
    proc.stdin.on('error', () => {})
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git check-attr exited ${code}`))
      // -z output is <path> NUL <attribute> NUL <value> NUL per file.
      const fields = Buffer.concat(stdout).toString().split('\0')
      const values = new Map<string, string>()
      for (let i = 0; i + 2 < fields.length; i += 3) values.set(fields[i]!, fields[i + 2]!)
      resolve(values)
    })
    proc.stdin.end(files.map((f) => f + '\0').join(''))
  })
}
