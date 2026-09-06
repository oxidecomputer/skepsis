/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { FileDiffMetadata } from '@pierre/diffs'

/**
 * Git shows a file to symlink change (or the reverse) as two diff blocks
 * for the same path, a delete of the old content followed by an add of the
 * new one. So parsePatchFiles returns two entries with the same name, and
 * CodeView throws a duplicate id error on the second one, which blanks the
 * whole UI. Merging keeps both hunks visible in a single item, and it
 * matches the server, which already keys fileHashes by name.
 *
 * Mutates in place. The inputs are freshly parsed in the same memo, and
 * keeping the first entry's identity stable avoids needless CodeView
 * re-renders of unaffected files.
 */
export function mergeDuplicateFiles(files: FileDiffMetadata[]): FileDiffMetadata[] {
  const groups = new Map<string, FileDiffMetadata[]>()
  for (const f of files) {
    const group = groups.get(f.name)
    if (group) group.push(f)
    else groups.set(f.name, [f])
  }
  const merged: FileDiffMetadata[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]!)
      continue
    }
    const first = group[0]!
    const last = group[group.length - 1]!
    let additionLines: string[] = []
    let deletionLines: string[] = []
    let splitOffset = 0
    let unifiedOffset = 0
    const hunks: FileDiffMetadata['hunks'] = []
    for (const f of group) {
      const addBase = additionLines.length
      const delBase = deletionLines.length
      additionLines = additionLines.concat(f.additionLines)
      deletionLines = deletionLines.concat(f.deletionLines)
      for (const h of f.hunks) {
        h.additionLineIndex += addBase
        h.deletionLineIndex += delBase
        h.splitLineStart += splitOffset
        h.unifiedLineStart += unifiedOffset
        for (const c of h.hunkContent) {
          c.additionLineIndex += addBase
          c.deletionLineIndex += delBase
        }
        hunks.push(h)
      }
      splitOffset += f.splitLineCount
      unifiedOffset += f.unifiedLineCount
    }
    first.type = 'change'
    first.hunks = hunks
    first.additionLines = additionLines
    first.deletionLines = deletionLines
    first.splitLineCount = splitOffset
    first.unifiedLineCount = unifiedOffset
    const oldMode = first.prevMode ?? first.mode
    first.mode = last.mode ?? first.mode
    first.prevMode = oldMode
    first.newObjectId = last.newObjectId
    merged.push(first)
  }
  return merged
}
