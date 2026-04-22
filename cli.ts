/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn, execFileSync } from 'child_process'
import { Command } from '@commander-js/extra-typings'
import { startServer } from './server/main.ts'
import type { DiffArgs } from './shared/types.ts'

const program = new Command()
  .name('skepsis')
  .description('Local diff review UI (auto-detects jj or git)')
  .option('-r, --revisions <revsets>', 'Show changes in these revisions')
  .option('-f, --from <rev>', 'Show changes from this revision')
  .option('-t, --to <rev>', 'Show changes to this revision')
  .option('--git', 'force git mode (skip jj detection)')
  .option('--dev', 'run with Vite dev server for development')
  .argument('[files...]', 'Limit diff to these paths (passed through to jj/git)')
  .parse()

const opts = program.opts()
const files = program.processedArgs[0] ?? []

function detectVcs(): 'jj' | 'git' {
  try {
    execFileSync('jj', ['root'], { stdio: 'ignore' })
    return 'jj'
  } catch {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
      return 'git'
    } catch {
      throw new Error('Not in a jj or git repository')
    }
  }
}

const vcs = opts.git ? 'git' : detectVcs()

function buildDiffSource(): DiffArgs {
  if (vcs === 'jj') {
    const args: string[] = []
    let commentsEnabled: boolean
    if (opts.from || opts.to) {
      if (opts.from) args.push('--from', opts.from)
      if (opts.to) args.push('--to', opts.to)
      // Comments enabled if --to is @ or omitted (jj defaults --to to @)
      commentsEnabled = !opts.to || opts.to === '@'
    } else {
      const rev = opts.revisions ?? 'trunk()..@'
      args.push('-r', rev)
      // Comments enabled if the revset's "to" side is @
      commentsEnabled = rev === '@' || rev.endsWith('..@')
    }
    return { vcs: 'jj', args, commentsEnabled, files }
  } else {
    let args: string[]
    let commentsEnabled: boolean
    if (opts.from || opts.to) {
      if (opts.to) {
        // Explicit --to: commit-to-commit diff, no working copy
        args = [opts.from ?? 'HEAD', opts.to]
        commentsEnabled = false
      } else {
        // --from only: git diff <from> includes working tree
        args = [opts.from!]
        commentsEnabled = true
      }
    } else {
      const rev = opts.revisions ?? 'origin/HEAD..HEAD'
      // No .. means single ref, which diffs against working tree
      commentsEnabled = !rev.includes('..')
      args = [rev]
    }
    return { vcs: 'git', args, commentsEnabled, files }
  }
}

const diffSource = buildDiffSource()

const cwd = process.cwd()
const projectRoot = import.meta.dirname
const children: ReturnType<typeof spawn>[] = []

function cleanup(code = 0) {
  for (const child of children) child.kill()
  process.exit(code)
}

process.on('SIGINT', () => cleanup())
process.on('SIGTERM', () => cleanup())

const apiPort = await startServer({ diffSource, cwd })

if (opts.dev) {
  const vite = spawn('npx', ['vite', '--open'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: String(apiPort) },
  })
  children.push(vite)
} else {
  spawn('open', [`http://localhost:${apiPort}`])
}
