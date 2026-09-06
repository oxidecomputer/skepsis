/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { parsePatchFiles } from '@pierre/diffs'
import { mergeDuplicateFiles } from './diffFiles.ts'

// Git shows a file to symlink change as a delete block plus an add block
// for the same path. That exact shape crashed CodeView with a duplicate
// id error for CLAUDE.md.
const FILE_TO_SYMLINK = `diff --git a/real.txt b/real.txt
deleted file mode 100644
index ce01362..0000000
--- a/real.txt
+++ /dev/null
@@ -1 +0,0 @@
-hello
diff --git a/real.txt b/real.txt
new file mode 120000
index 0000000..4cbb553
--- /dev/null
+++ b/real.txt
@@ -0,0 +1 @@
+target.txt
\\ No newline at end of file
`

const SYMLINK_TO_FILE = `diff --git a/link.txt b/link.txt
deleted file mode 120000
index 4cbb553..0000000
--- a/link.txt
+++ /dev/null
@@ -1 +0,0 @@
-target.txt
\\ No newline at end of file
diff --git a/link.txt b/link.txt
new file mode 100644
index 0000000..00f7f45
--- /dev/null
+++ b/link.txt
@@ -0,0 +1 @@
+regular file now
`

function parse(patch: string) {
  return parsePatchFiles(patch).flatMap((p) => p.files)
}

describe('mergeDuplicateFiles', () => {
  it('leaves unique files untouched', () => {
    const solo = parse(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`)
    const merged = mergeDuplicateFiles(solo)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(solo[0])
  })

  it('merges a file-to-symlink typechange into one entry', () => {
    const merged = mergeDuplicateFiles(parse(FILE_TO_SYMLINK))
    expect(merged).toHaveLength(1)
    const f = merged[0]!
    expect(f.name).toBe('real.txt')
    expect(f.type).toBe('change')
    // Both sides stay visible, the deleted file content and the link target.
    expect(f.deletionLines).toEqual(['hello\n'])
    expect(f.additionLines).toEqual(['target.txt'])
    expect(f.hunks).toHaveLength(2)
    expect(f.prevObjectId).toBe('ce01362')
    expect(f.newObjectId).toBe('4cbb553')
    expect(f.mode).toBe('120000')
  })

  it('merges a symlink-to-file typechange into one entry', () => {
    const merged = mergeDuplicateFiles(parse(SYMLINK_TO_FILE))
    expect(merged).toHaveLength(1)
    const f = merged[0]!
    expect(f.name).toBe('link.txt')
    expect(f.deletionLines).toEqual(['target.txt'])
    expect(f.additionLines).toEqual(['regular file now\n'])
    expect(f.hunks).toHaveLength(2)
  })

  it('reindexes hunk line pointers into the merged arrays', () => {
    const merged = mergeDuplicateFiles(parse(FILE_TO_SYMLINK))
    const f = merged[0]!
    for (const h of f.hunks) {
      expect(h.additionLineIndex + h.additionLines).toBeLessThanOrEqual(
        f.additionLines.length,
      )
      expect(h.deletionLineIndex + h.deletionLines).toBeLessThanOrEqual(
        f.deletionLines.length,
      )
      for (const c of h.hunkContent) {
        if (c.type === 'change') {
          expect(c.additionLineIndex + c.additions).toBeLessThanOrEqual(
            f.additionLines.length,
          )
          expect(c.deletionLineIndex + c.deletions).toBeLessThanOrEqual(
            f.deletionLines.length,
          )
        }
      }
    }
  })

  it('produces unique names for CodeView item ids', () => {
    const twoFiles = `${FILE_TO_SYMLINK}${SYMLINK_TO_FILE}`
    const merged = mergeDuplicateFiles(parse(twoFiles))
    const names = merged.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('real.txt')
    expect(names).toContain('link.txt')
  })
})
