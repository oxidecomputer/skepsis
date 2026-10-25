/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { parsePatchFiles } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import { diffChanges } from './diffChanges.ts'

const parse = (patch: string) => parsePatchFiles(patch).flatMap((p) => p.files)

/** A git patch for one modified file, from its hunk bodies. */
const modified = (name: string, index: string, body: string) =>
  `diff --git a/${name} b/${name}
index ${index} 100644
--- a/${name}
+++ b/${name}
${body}`

const A_TWO = modified(
  'a.ts',
  '1111111..2222222',
  `@@ -1,3 +1,3 @@
 const one = 1
-const two = 2
+const two = 22
 const three = 3
`,
)

const bin = (index: string) => `diff --git a/x.png b/x.png
index ${index} 100644
Binary files a/x.png and b/x.png differ
`

describe('diffChanges', () => {
  it('is empty for the same diff', () => {
    expect(diffChanges(parse(A_TWO), parse(A_TWO))).toEqual([])
  })

  it('counts an edit inside a hunk', () => {
    const after = modified(
      'a.ts',
      '1111111..3333333',
      `@@ -1,3 +1,3 @@
 const one = 1
-const two = 2
+const two = 222
 const three = 3
`,
    )
    expect(diffChanges(parse(A_TWO), parse(after))).toEqual([
      { name: 'a.ts', status: 'changed', additions: 1, deletions: 1 },
    ])
  })

  it('counts a newly deleted line as lost and a restored one as gained', () => {
    const after = modified(
      'a.ts',
      '1111111..4444444',
      `@@ -1,3 +1,2 @@
-const one = 1
 const two = 2
 const three = 3
`,
    )
    // two = 22 went back to two = 2 (+1 restored, -1 vanished addition), and
    // one = 1 is gone (-1).
    expect(diffChanges(parse(A_TWO), parse(after))).toEqual([
      { name: 'a.ts', status: 'changed', additions: 1, deletions: 2 },
    ])
  })

  it('reports files entering and leaving the diff', () => {
    const b = `diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@
+hello
+world
`
    expect(diffChanges(parse(A_TWO), parse(b))).toEqual([
      // No counts: the file could have been reverted or committed.
      { name: 'a.ts', status: 'removed', additions: 0, deletions: 0 },
      { name: 'b.txt', status: 'added', additions: 2, deletions: 0 },
    ])
  })

  it('reports a moved base without counts', () => {
    // A commit or rebase moved the base under an otherwise unchanged edit.
    const after = modified(
      'a.ts',
      '6666666..2222222',
      `@@ -1,3 +1,3 @@
 const one = 1
-const two = 20
+const two = 22
 const three = 3
`,
    )
    expect(diffChanges(parse(A_TWO), parse(after))).toEqual([
      { name: 'a.ts', status: 'base', additions: 0, deletions: 0 },
    ])
  })

  it('counts repeated lines', () => {
    const before = modified(
      'a.ts',
      '1111111..2222222',
      `@@ -1,1 +1,2 @@
 const one = 1
+}
+}
`,
    )
    const after = modified(
      'a.ts',
      '1111111..3333333',
      `@@ -1,1 +1,3 @@
 const one = 1
+}
+}
+}
`,
    )
    expect(diffChanges(parse(before), parse(after))).toEqual([
      { name: 'a.ts', status: 'changed', additions: 1, deletions: 0 },
    ])
  })

  it('reports a mode change with the same content', () => {
    const after = A_TWO.replace(
      'index 1111111..2222222 100644',
      'old mode 100644\nnew mode 100755\nindex 1111111..2222222',
    )
    expect(diffChanges(parse(A_TWO), parse(after))).toEqual([
      { name: 'a.ts', status: 'changed', additions: 0, deletions: 0 },
    ])
  })

  it('reports a binary change by its object ID', () => {
    expect(
      diffChanges(parse(bin('1111111..2222222')), parse(bin('1111111..3333333'))),
    ).toEqual([{ name: 'x.png', status: 'changed', additions: 0, deletions: 0 }])
    expect(
      diffChanges(parse(bin('1111111..2222222')), parse(bin('1111111..2222222'))),
    ).toEqual([])
  })
})
