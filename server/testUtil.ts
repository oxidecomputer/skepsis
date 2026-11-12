/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

export const exec = promisify(execFile)

const CLI = join(import.meta.dirname, '..', 'cli.ts')

/** Spawn the CLI in `dir` with --no-open and resolve with the URL it prints
 *  on startup. `env` replaces the environment when given. */
export function startCli(
  dir: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    // No --port means an ephemeral one, so parallel tests can't collide.
    const proc = spawn('node', [CLI, '--no-open', ...args], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const m = out.match(/skepsis on (http:\/\/[^\s]+)/)
      if (m) resolve({ proc, url: m[1]! })
    })
    let err = ''
    proc.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()))
    proc.on('error', reject)
    proc.on('exit', (code) => reject(new Error(`skepsis exited with ${code}: ${err}`)))
  })
}

/** Run a command in a repo dir, rejecting on nonzero exit. */
export const run = (cmd: string, args: string[], cwd: string) => exec(cmd, args, { cwd })

/** Throw a useful error when jj isn't installed, instead of the bare
 *  `spawn jj ENOENT` a jj command would produce. Call in beforeAll so only
 *  the jj suite fails. */
export async function requireJj(): Promise<void> {
  await exec('jj', ['--version']).catch(() => {
    throw new Error('these tests require jj on the PATH')
  })
}

/**
 * Point git and jj at test-controlled config (in a temp HOME) so the user's
 * real config can't leak into test repos. Mutates process.env rather than
 * injecting env per spawn so that processes the server spawns itself are
 * isolated too; vitest runs each test file in its own process, so the
 * mutation doesn't leak across files. Both tools get a test identity so
 * commits work. Returns the temp HOME dir for the caller to clean up.
 */
export async function isolateVcsConfig(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'skepsis-test-home-'))
  process.env.HOME = home
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig')
  await writeFile(
    process.env.GIT_CONFIG_GLOBAL,
    '[user]\nemail = test@example.com\nname = Test\n',
  )
  process.env.JJ_CONFIG = join(home, 'jj-config.toml')
  await writeFile(
    process.env.JJ_CONFIG,
    '[user]\nname = "Test"\nemail = "test@example.com"\n',
  )
  return home
}
