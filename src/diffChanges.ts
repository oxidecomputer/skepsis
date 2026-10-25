/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { FileDiffMetadata } from '@pierre/diffs'

/** How one file's diff differs between the diff on screen and a newer one. */
export interface FileChange {
  name: string
  /** added: newly in the diff. removed: left it (now matches the base).
   *  changed: in both, with different content. base: in both, against a
   *  different version of the file (a commit, a rebase, an edit to the
   *  parent). */
  status: 'added' | 'removed' | 'changed' | 'base'
  /** Lines the file's new side gained and lost since the diff on screen. Zero
   *  for removed and base, where the two diffs don't share a base to count
   *  against: a removed file could be a revert or a commit of the change. */
  additions: number
  deletions: number
}

function tally(map: Map<string, number>, lines: string[], start: number, n: number) {
  for (const line of lines.slice(start, start + n)) map.set(line, (map.get(line) ?? 0) + 1)
}

/** A file's +/- lines, as counts per line text. */
function changeLines(file: FileDiffMetadata | undefined) {
  const added = new Map<string, number>()
  const deleted = new Map<string, number>()
  for (const hunk of file?.hunks ?? []) {
    for (const block of hunk.hunkContent) {
      if (block.type !== 'change') continue
      tally(added, file!.additionLines, block.additionLineIndex, block.additions)
      tally(deleted, file!.deletionLines, block.deletionLineIndex, block.deletions)
    }
  }
  return { added, deleted }
}

/** How many lines of `a` are missing from `b`, counting repeats. */
function missing(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0
  for (const [line, count] of a) n += Math.max(0, count - (b.get(line) ?? 0))
  return n
}

/**
 * The files whose diff changed between `before` and `after`, two parsed
 * patches. Unsorted: the caller orders them to match its file list.
 *
 * The counts compare the two diffs' changed lines as multisets rather than
 * diffing the files, which the partial patches can't do. A newly added line
 * or a vanished deletion is a line the file gained; a vanished addition or a
 * new deletion is one it lost. That's exact for edits inside the hunks and
 * ignores lines that only moved.
 */
export function diffChanges(
  before: readonly FileDiffMetadata[],
  after: readonly FileDiffMetadata[],
): FileChange[] {
  const old = new Map(before.map((f) => [f.name, f]))
  const cur = new Map(after.map((f) => [f.name, f]))
  const changes: FileChange[] = []
  for (const name of new Set([...old.keys(), ...cur.keys()])) {
    const o = old.get(name)
    const c = cur.get(name)
    if (!c) {
      changes.push({ name, status: 'removed', additions: 0, deletions: 0 })
      continue
    }
    if (o && o.prevObjectId !== c.prevObjectId) {
      changes.push({ name, status: 'base', additions: 0, deletions: 0 })
      continue
    }
    const a = changeLines(o)
    const b = changeLines(c)
    const additions = missing(b.added, a.added) + missing(a.deleted, b.deleted)
    const deletions = missing(a.added, b.added) + missing(b.deleted, a.deleted)
    // A binary file or one whose lines only moved has no counts; its object
    // ID still tells whether it changed.
    const same =
      o &&
      additions === 0 &&
      deletions === 0 &&
      o.newObjectId === c.newObjectId &&
      o.mode === c.mode
    if (!same) changes.push({ name, status: o ? 'changed' : 'added', additions, deletions })
  }
  return changes
}
