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

const PLAIN = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`

describe('mergeDuplicateFiles', () => {
  it('folds each typechange into one diff and leaves other files alone', () => {
    const files = parsePatchFiles(FILE_TO_SYMLINK + PLAIN + SYMLINK_TO_FILE).flatMap(
      (p) => p.files,
    )
    const merged = mergeDuplicateFiles(files)
    expect(merged.map((f) => f.name)).toEqual(['real.txt', 'a.txt', 'link.txt'])
    expect(merged[1]).toBe(files[2])
    const [real, , link] = merged
    expect(real).toMatchObject({
      type: 'change',
      deletionLines: ['hello\n'],
      additionLines: ['target.txt'],
      prevObjectId: 'ce01362',
      newObjectId: '4cbb553',
      mode: '120000',
    })
    expect(link).toMatchObject({
      deletionLines: ['target.txt'],
      additionLines: ['regular file now\n'],
    })
  })
})
