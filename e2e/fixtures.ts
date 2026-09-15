/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base } from '@playwright/test'
import { exec } from '../server/testUtil.ts'

export * from '@playwright/test'

/** A temp git repo with one committed version of each file and uncommitted
 *  working-copy edits, served by a real skepsis process. */
export type Repo = {
  dir: string
  url: string
  /** Read a working-copy file. */
  read: (name: string) => Promise<string>
  /** Overwrite a working-copy file (the next /api/diff picks it up). */
  write: (name: string, contents: string) => Promise<void>
}

export const COMMITTED: Record<string, string> = {
  'a.ts': 'const one = 1\nconst two = 2\nconst three = 3\n',
  'b.txt': 'hello\n',
}

export const WORKING: Record<string, string> = {
  'a.ts': 'const one = 1\nconst two = 22\nconst three = 3\nconst four = 4\n',
  'b.txt': 'hello\nworld\n',
}

const CLI = join(import.meta.dirname, '..', 'cli.ts')

const writeFiles = (dir: string, files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(dir, name), contents)),
  )

/** Spawn the CLI in `dir` and resolve with the URL it prints on startup. */
function startCli(dir: string, home: string): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    // --host 127.0.0.1 suppresses the auto-open of a browser. No --port means
    // an ephemeral one, so parallel tests can't collide.
    const proc = spawn('node', [CLI, '--git', '--host', '127.0.0.1'], {
      cwd: dir,
      env: {
        ...process.env,
        // Viewed state and settings live under HOME; keep them out of the
        // real ones. Git config is isolated so the user's can't leak in.
        HOME: home,
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
      },
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

export const test = base.extend<{ repo: Repo }>({
  // auto: every test gets a server even if it never touches `repo`.
  repo: [
    async ({ page }, use) => {
      const dir = await mkdtemp(join(tmpdir(), 'skepsis-e2e-repo-'))
      const home = await mkdtemp(join(tmpdir(), 'skepsis-e2e-home-'))
      await writeFile(
        join(home, 'gitconfig'),
        '[user]\nemail = test@example.com\nname = Test\n',
      )
      const git = (...args: string[]) =>
        exec('git', args, {
          cwd: dir,
          env: {
            ...process.env,
            HOME: home,
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
          },
        })

      // A `main` branch is what the CLI's default diff resolves as trunk.
      await git('init', '-q', '-b', 'main')
      await writeFiles(dir, COMMITTED)
      await git('add', '.')
      await git('commit', '-qm', 'init')
      await writeFiles(dir, WORKING)

      const { proc, url } = await startCli(dir, home)
      await page.goto(url)
      // The diff is fetched after load; wait for it so tests can act at once.
      await page.locator('.file-header').first().waitFor()
      await use({
        dir,
        url,
        read: (name) => readFile(join(dir, name), 'utf8'),
        write: (name, contents) => writeFile(join(dir, name), contents),
      })

      proc.kill()
      await rm(dir, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    },
    { auto: true },
  ],
})
