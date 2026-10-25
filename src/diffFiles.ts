/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'

/**
 * Git shows a file swapped for a symlink (or the reverse) as two diff blocks
 * for the same path: a deletion carrying all of the old content and an
 * addition carrying all of the new. CodeView needs one item per name, so
 * rebuild each such pair as a single diff between those two sides.
 */
export function mergeDuplicateFiles(files: FileDiffMetadata[]): FileDiffMetadata[] {
  return [...Map.groupBy(files, (f) => f.name).values()].map((group) => {
    if (group.length === 1) return group[0]!
    const before = group[0]!
    const after = group.at(-1)!
    const diff = parseDiffFromFile(
      { name: before.name, contents: before.deletionLines.join('') },
      { name: after.name, contents: after.additionLines.join('') },
    )
    return Object.assign(diff, {
      prevMode: before.mode,
      mode: after.mode,
      prevObjectId: before.prevObjectId,
      newObjectId: after.newObjectId,
    })
  })
}
