#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn, execFileSync } from 'child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command } from '@commander-js/extra-typings'
import { startServer } from './server/main.ts'
import type { DiffArgs, DiffEndpoints } from './shared/types.ts'

const program = new Command()
  .name('skepsis')
  .description('Local diff review UI (auto-detects jj or git)')
  .option('-r, --revisions <revsets>', 'Show changes in these revisions')
  .option('-f, --from <rev>', 'Show changes from this revision')
  .option('-t, --to <rev>', 'Show changes to this revision')
  .option('--git', 'force git mode (skip jj detection)')
  .option('--dev', 'run with Vite dev server for development')
  .option('--host <address>', 'address to bind the HTTP server to', 'localhost')
  .argument('[files...]', 'Limit diff to these paths (passed through to jj/git)')
  .parse()

const opts = program.opts()
const files = program.processedArgs[0] ?? []
const hostname = opts.host

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

/* Base rev candidates for the default git diff. origin/HEAD only exists when
 * a clone set it (git clone does, git remote add does not), so fall back to
 * common default-branch names, remote-tracking first — a poor man's version
 * of what jj's trunk() does. */
const GIT_BASE_CANDIDATES = [
  'origin/HEAD',
  'origin/main',
  'origin/master',
  'main',
  'master',
]

function resolveGitBase(): string {
  for (const rev of GIT_BASE_CANDIDATES) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
        stdio: 'ignore',
      })
      return rev
    } catch {
      // try the next candidate
    }
  }
  console.error(
    `No base revision found for the default diff (tried ${GIT_BASE_CANDIDATES.join(', ')}).\n` +
      'Specify a range explicitly with -r or -f/-t.',
  )
  process.exit(1)
}

/** Split an `A..B` range into its two revs. Returns null for anything that
 *  isn't a simple two-sided range with both sides non-empty. */
function parseRange(rev: string): { left: string; right: string } | null {
  const idx = rev.indexOf('..')
  if (idx < 0 || rev.includes('...')) return null
  const left = rev.slice(0, idx)
  const right = rev.slice(idx + 2)
  if (!left || !right || right.includes('..')) return null
  return { left, right }
}

function buildDiffSource(): DiffArgs {
  if (vcs === 'jj') {
    const args: string[] = []
    let commentsEnabled: boolean
    let endpoints: DiffEndpoints
    if (opts.from || opts.to) {
      if (opts.from) args.push('--from', opts.from)
      if (opts.to) args.push('--to', opts.to)
      // Comments enabled if --to is @ or omitted (jj defaults --to to @)
      commentsEnabled = !opts.to || opts.to === '@'
      // jj defaults both --from and --to to @
      endpoints = { left: opts.from ?? '@', right: { rev: opts.to ?? '@' } }
    } else if (!opts.revisions) {
      // Default: GitHub-PR-style diff from the fork point of trunk and @.
      // Same output as `-r 'trunk()..@'` for a linear branch, but still works
      // after trunk has been merged into the branch, where jj rejects
      // `trunk()..@` ("Cannot diff revsets with gaps in"). fork_point()
      // requires jj >= 0.24.
      const from = 'fork_point(trunk() | @)'
      args.push('--from', from)
      commentsEnabled = true
      endpoints = { left: from, right: { rev: '@' } }
    } else {
      const rev = opts.revisions
      args.push('-r', rev)
      // Comments enabled if the revset's "to" side is @
      commentsEnabled = rev === '@' || rev.endsWith('..@')
      const range = parseRange(rev)
      if (range) {
        endpoints = { left: range.left, right: { rev: range.right } }
      } else if (!rev.includes('..')) {
        // Single rev: `jj diff -r R` shows R's own change, i.e. R-..R.
        endpoints = { left: `${rev}-`, right: { rev } }
      } else {
        endpoints = null
      }
    }
    return { vcs: 'jj', args, commentsEnabled, files, endpoints }
  } else {
    let args: string[]
    let commentsEnabled: boolean
    let endpoints: DiffEndpoints
    if (opts.from || opts.to) {
      if (opts.to) {
        // Explicit --to: commit-to-commit diff, no working copy
        args = [opts.from ?? 'HEAD', opts.to]
        commentsEnabled = false
        endpoints = { left: opts.from ?? 'HEAD', right: { rev: opts.to } }
      } else {
        // --from only: git diff <from> includes working tree
        args = [opts.from!]
        commentsEnabled = true
        endpoints = { left: opts.from!, right: 'workingCopy' }
      }
    } else if (!opts.revisions) {
      // Default: GitHub-PR-style three-dot diff, i.e. from merge-base(A, B)
      // to B, so upstream commits the branch doesn't have don't show up as
      // reversions (two-dot `git diff A..B` compares A and B directly).
      const base = resolveGitBase()
      args = [`${base}...HEAD`]
      commentsEnabled = false
      // `git show 'A...B:path'` isn't valid, so resolve the merge base up
      // front for the left endpoint. If it fails (e.g. unrelated histories),
      // leave expansion disabled and let diff validation report any error.
      let mergeBase: string | null = null
      try {
        mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {
        mergeBase = null
      }
      endpoints = mergeBase ? { left: mergeBase, right: { rev: 'HEAD' } } : null
    } else {
      const rev = opts.revisions
      // No .. means single ref, which diffs against working tree
      commentsEnabled = !rev.includes('..')
      args = [rev]
      const range = parseRange(rev)
      if (range) {
        endpoints = { left: range.left, right: { rev: range.right } }
      } else if (!rev.includes('..')) {
        endpoints = { left: rev, right: 'workingCopy' }
      } else {
        endpoints = null
      }
    }
    return { vcs: 'git', args, commentsEnabled, files, endpoints }
  }
}

const diffSource = buildDiffSource()

const cwd = process.cwd()
const children: ReturnType<typeof spawn>[] = []

function findCheckoutRoot(): string | null {
  const sourceRoot = import.meta.dirname
  if (existsSync(join(sourceRoot, 'vite.config.ts'))) return sourceRoot

  const packageRoot = dirname(sourceRoot)
  if (existsSync(join(packageRoot, 'vite.config.ts'))) return packageRoot

  return null
}

function cleanup(code = 0): never {
  for (const child of children) child.kill()
  process.exit(code)
}

function requireCheckoutRoot(): string {
  const checkoutRoot = findCheckoutRoot()
  if (checkoutRoot === null) {
    console.error(
      '--dev only works from a skepsis source checkout, not the installed package.\n' +
        'Clone https://github.com/oxidecomputer/skepsis and run: node cli.ts --dev',
    )
    cleanup(1)
  }
  return checkoutRoot
}

process.on('SIGINT', () => cleanup())
process.on('SIGTERM', () => cleanup())

const checkoutRoot = opts.dev ? requireCheckoutRoot() : undefined
const apiPort = await startServer({ diffSource, cwd, hostname })

function urlOpenCommand(url: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] }
    case 'win32':
      return { cmd: 'cmd', args: ['/c', 'start', '', url] }
    default:
      return { cmd: 'xdg-open', args: [url] }
  }
}

// Only auto-open a browser when bound to localhost. With any other host,
// the user is likely on a remote dev box and the browser lives elsewhere
// — opening locally would just spawn an unwanted browser.
const shouldAutoOpen = hostname === 'localhost'

if (opts.dev) {
  const viteArgs = ['vite', '--host', hostname]
  if (shouldAutoOpen) viteArgs.push('--open')
  const vite = spawn('npx', viteArgs, {
    cwd: checkoutRoot,
    stdio: 'inherit',
    env: { ...process.env, API_HOST: hostname, API_PORT: String(apiPort) },
  })
  children.push(vite)
} else if (shouldAutoOpen) {
  const url = `http://localhost:${apiPort}`
  const { cmd, args } = urlOpenCommand(url)
  const opener = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  opener.on('error', (err) => {
    console.error(`Could not open URL with ${cmd}: ${err.message}`)
    console.error(`Open ${url} to see the diff`)
  })
  opener.unref()
}
