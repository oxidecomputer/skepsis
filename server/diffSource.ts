/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Turning the CLI's range flags into the diff command to run. Errors are
 * thrown with a message for the user, which the CLI prints.
 */

import { execFileSync } from 'node:child_process'
import type { DiffArgs, DiffEndpoints } from '../shared/types.ts'

export function detectVcs(): 'jj' | 'git' {
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

/* Base rev candidates for the default git diff. A remote's default branch
 * (origin/HEAD) is optional — "Having a default branch for a remote is not
 * required" (https://git-scm.com/docs/git-remote, set-head) — so fall back to
 * common default-branch names, remote-tracking first — a poor man's version
 * of what jj's trunk() does. */
const GIT_BASE_CANDIDATES = [
  'origin/HEAD',
  'origin/main',
  'origin/master',
  'main',
  'master',
]

/** Find the trunk-ish base for the default diff, plus its merge base with
 *  HEAD. Probing with `git merge-base` both verifies the candidate exists and
 *  yields the fork-point sha in one step. */
function resolveGitBase(): { base: string; mergeBase: string } {
  for (const base of GIT_BASE_CANDIDATES) {
    try {
      const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      return { base, mergeBase }
    } catch (error) {
      // A missing candidate or no common ancestor means try the next one, but
      // outside a repo or without git installed every candidate fails the
      // same way — git's own error beats a misleading "no base revision
      // found" that suggests -r/-f flags that would also fail.
      const { code, stderr } = error as { code?: string; stderr?: string }
      if (code === 'ENOENT' || stderr?.includes('not a git repository')) {
        throw new Error(stderr?.trim() || (error as Error).message, { cause: error })
      }
    }
  }
  throw new Error(
    `No base revision found for the default diff (tried ${GIT_BASE_CANDIDATES.join(', ')}).\n` +
      'Specify a range explicitly with -r or -f/-t.',
  )
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

/** The diff the CLI's flags ask for. Throws on a combination it refuses */
export function buildDiffSource(flags: {
  vcs: 'jj' | 'git'
  /** -r */
  revisions?: string
  /** -f */
  from?: string
  /** -t */
  to?: string
  interdiff?: boolean
  files?: string[]
}): DiffArgs {
  const { vcs, revisions, from, to, interdiff, files = [] } = flags
  if (interdiff) {
    if (vcs !== 'jj') throw new Error('--interdiff needs jj')
    if (revisions) throw new Error("--interdiff can't be combined with -r")
    // Without this, jj's own usage error shows up as "jj interdiff failed"
    if (!from && !to) throw new Error('--interdiff needs -f, -t, or both')
  }

  if (vcs === 'jj') {
    const args: string[] = []
    let toWorkingCopy: boolean
    let endpoints: DiffEndpoints
    if (from || to || !revisions) {
      // With no range flags at all, --from defaults to a GitHub-PR-style diff
      // from the fork point of trunk and @. Same output as `-r 'trunk()..@'`
      // for a linear branch, but still works after trunk has been merged into
      // the branch, where jj rejects `trunk()..@` ("Cannot diff revsets with
      // gaps in"). fork_point() requires jj >= 0.24
      // (https://github.com/jj-vcs/jj/releases/tag/v0.24.0).
      const left = from ?? (to ? undefined : 'fork_point(trunk() | @)')
      if (left) args.push('--from', left)
      if (to) args.push('--to', to)
      // jj defaults both --from and --to to @
      toWorkingCopy = !to || to === '@'
      // An interdiff's left side is --from rebased onto --to's parents, which
      // isn't a revision `jj file show` can read, so there's no hunk
      // expansion. Rebuilding the left file by applying the file's patch in
      // reverse to the right one would make it work.
      endpoints = interdiff ? null : { left: left ?? '@', right: { rev: to ?? '@' } }
    } else {
      const rev = revisions
      args.push('-r', rev)
      toWorkingCopy = rev === '@' || rev.endsWith('..@')
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
    return { vcs: 'jj', interdiff, args, toWorkingCopy, files, endpoints }
  } else {
    let args: string[]
    let toWorkingCopy: boolean
    let endpoints: DiffEndpoints
    let displayArgs: string[] | undefined
    if (from || to) {
      if (to) {
        // Explicit --to: commit-to-commit diff, no working copy
        args = [from ?? 'HEAD', to]
        toWorkingCopy = false
        endpoints = { left: from ?? 'HEAD', right: { rev: to } }
      } else {
        // --from only: git diff <from> includes working tree
        args = [from!]
        toWorkingCopy = true
        endpoints = { left: from!, right: 'workingCopy' }
      }
    } else if (!revisions) {
      // Default: the git translation of the jj default — diff the working
      // tree against the branch's fork point from trunk (the merge base of
      // the resolved base and HEAD). Using the merge base keeps upstream
      // commits the branch doesn't have from showing up as reversions, and
      // ending at the working tree means review comments work out of the box.
      // Diffing against the resolved sha rather than `git diff --merge-base
      // <base>` pins the diff and hunk expansion to the same commit — they
      // can't drift apart if the base moves while the server runs — and
      // avoids --merge-base's hard error when there are multiple merge bases.
      // The sha is unreadable, so show the equivalent symbolic command in the
      // UI and log.
      const { base, mergeBase } = resolveGitBase()
      args = [mergeBase]
      displayArgs = ['--merge-base', base]
      toWorkingCopy = true
      endpoints = { left: mergeBase, right: 'workingCopy' }
    } else {
      const rev = revisions
      // No .. means single ref, which diffs against working tree
      toWorkingCopy = !rev.includes('..')
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
    return { vcs: 'git', args, toWorkingCopy, files, endpoints, displayArgs }
  }
}
