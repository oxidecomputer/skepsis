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
   *  changed: in both, with different content. */
  status: 'added' | 'removed' | 'changed'
  /** Lines the file's new side gained and lost since the diff on screen. */
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
 * The files whose diff changed between `before` and `after`, both parsed
 * patches against the same base. Unsorted: the caller orders them to match
 * its file list.
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
    const a = changeLines(o)
    const b = changeLines(c)
    const additions = missing(b.added, a.added) + missing(a.deleted, b.deleted)
    const deletions = missing(a.added, b.added) + missing(b.deleted, a.deleted)
    const status = !o ? 'added' : !c ? 'removed' : 'changed'
    // A binary file or one whose lines only moved has no counts; its object
    // ID still tells whether it changed.
    const same =
      status === 'changed' &&
      additions === 0 &&
      deletions === 0 &&
      o!.newObjectId === c!.newObjectId &&
      o!.mode === c!.mode
    if (!same) changes.push({ name, status, additions, deletions })
  }
  return changes
}
