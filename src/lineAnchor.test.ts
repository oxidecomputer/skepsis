/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { parseDiffFromFile, parsePatchFiles } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import { lineText, relocateLine } from './lineAnchor.ts'

const NAME = 'f.ts'
const contents = (lines: string[]) => lines.map((l) => `${l}\n`).join('')

/** A stand-in for a blob ID: distinct contents get distinct IDs. */
function blobId(text: string) {
  if (text === '') return '0000000'
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 7)
}

/** The diff the app gets for an expanded file: every line, with the patch's
 *  object IDs copied on. */
function whole(base: string[], wc: string[]) {
  return {
    ...parseDiffFromFile(
      { name: NAME, contents: contents(base) },
      { name: NAME, contents: contents(wc) },
      { context: Number.MAX_SAFE_INTEGER },
    ),
    prevObjectId: blobId(contents(base)),
    newObjectId: blobId(contents(wc)),
  }
}

/**
 * The diff the app gets from git: a 3-line-context patch, parsed. The hunks
 * come from jsdiff via parseDiffFromFile (they match `git diff` for these
 * inputs), written out as patch text so parsePatchFiles builds the partial
 * line arrays itself.
 */
function partial(base: string[], wc: string[]) {
  const d = parseDiffFromFile(
    { name: NAME, contents: contents(base) },
    { name: NAME, contents: contents(wc) },
    { context: 3 },
  )
  let body = ''
  for (const h of d.hunks) {
    body += h.hunkSpecs
    for (const c of h.hunkContent) {
      if (c.type === 'context') {
        for (let i = 0; i < c.lines; i++)
          body += ` ${d.additionLines[c.additionLineIndex + i]}`
      } else {
        for (let i = 0; i < c.deletions; i++)
          body += `-${d.deletionLines[c.deletionLineIndex + i]}`
        for (let i = 0; i < c.additions; i++)
          body += `+${d.additionLines[c.additionLineIndex + i]}`
      }
    }
  }
  const ids = `${blobId(contents(base))}..${blobId(contents(wc))}`
  const header =
    base.length === 0
      ? `new file mode 100644\nindex ${ids}\n--- /dev/null\n`
      : `index ${ids} 100644\n--- a/${NAME}\n`
  const patch = `diff --git a/${NAME} b/${NAME}\n${header}+++ b/${NAME}\n${body}`
  return parsePatchFiles(patch).flatMap((p) => p.files)[0]!
}

const KINDS = { p: partial, w: whole }

/**
 * relocateLine for each pairing of partial (p) and whole-file (w) diffs, as
 * { [before kind + after kind]: result }. `before` diffs `wc1` against `base`;
 * `after` diffs `wc2` against `base2`, which defaults to the same base.
 */
function relocate(
  {
    base,
    wc1,
    wc2,
    base2 = base,
  }: { base: string[]; wc1: string[]; wc2: string[]; base2?: string[] },
  line: number,
  side: 'additions' | 'deletions' = 'additions',
) {
  const out: Record<string, number | null> = {}
  for (const [k1, f1] of Object.entries(KINDS)) {
    for (const [k2, f2] of Object.entries(KINDS)) {
      out[k1 + k2] = relocateLine(f1(base, wc1), f2(base2, wc2), side, line)
    }
  }
  return out
}

const xs = (n: number) => Array.from({ length: n }, () => 'x')

const all = (n: number | null) => ({ pp: n, pw: n, wp: n, ww: n })

/** Replace `remove` lines starting at 1-based `line` with `insert`. */
const edit = (lines: string[], line: number, remove: number, ...insert: string[]) =>
  lines.toSpliced(line - 1, remove, ...insert)

/** n four-line functions: fK's `{` line is 4K-3, return 4K-2, `}` 4K-1, blank 4K. */
const fns = (n: number) =>
  Array.from({ length: n }, (_, i) => [
    `function f${i + 1}() {`,
    `  return ${i + 1}`,
    '}',
    '',
  ]).flat()

const BASE = fns(10)
// f5's return edited. Its partial diff shows lines 15-21.
const WC = edit(BASE, 18, 1, '  return 50')

describe('lineText', () => {
  it('reads partial diffs through their hunks', () => {
    const wc = edit(edit(WC, 30, 1, '  return 80'), 2, 1, '  return 10')
    const d = partial(BASE, wc)
    expect(d.hunks.length).toBe(3)
    expect(lineText(d, 'additions', 2)).toBe('  return 10')
    expect(lineText(d, 'additions', 18)).toBe('  return 50')
    expect(lineText(d, 'additions', 15)).toBe('}')
    expect(lineText(d, 'additions', 30)).toBe('  return 80')
    expect(lineText(d, 'deletions', 30)).toBe('  return 8')
    expect(lineText(d, 'additions', 14)).toBeUndefined()
    expect(lineText(d, 'additions', 22)).toBeUndefined()
    expect(lineText(d, 'additions', 0)).toBeUndefined()
  })

  it('reads every line of a whole-file diff', () => {
    const d = whole(BASE, WC)
    expect(lineText(d, 'additions', 1)).toBe('function f1() {')
    expect(lineText(d, 'additions', 18)).toBe('  return 50')
    expect(lineText(d, 'deletions', 18)).toBe('  return 5')
    expect(lineText(d, 'additions', 40)).toBe('')
    expect(lineText(d, 'additions', 41)).toBeUndefined()
    expect(lineText(d, 'additions', 0)).toBeUndefined()
  })

  it('reads a new file', () => {
    const d = partial([], ['a', 'b'])
    expect(lineText(d, 'additions', 2)).toBe('b')
    expect(lineText(d, 'deletions', 1)).toBeUndefined()
  })
})

describe('relocateLine', () => {
  it('keeps the line when nothing changed', () => {
    const diffs = { base: BASE, wc1: WC, wc2: WC }
    expect(relocate(diffs, 18)).toEqual(all(18))
    expect(relocate(diffs, 19)).toEqual(all(19))
  })

  it('places only lines both diffs show', () => {
    expect(relocate({ base: BASE, wc1: WC, wc2: WC }, 30)).toEqual({
      pp: null,
      pw: null,
      wp: null,
      ww: 30,
    })
  })

  it('follows lines inserted far above', () => {
    const diffs = { base: BASE, wc1: WC, wc2: edit(WC, 2, 0, '  // one', '  // two') }
    expect(relocate(diffs, 18)).toEqual(all(20))
    expect(relocate(diffs, 19)).toEqual(all(21))
    expect(relocate(diffs, 15)).toEqual(all(17))
  })

  it('follows lines deleted above', () => {
    const diffs = { base: BASE, wc1: WC, wc2: edit(WC, 1, 4) }
    expect(relocate(diffs, 18)).toEqual(all(14))
    expect(relocate(diffs, 19)).toEqual(all(15))
  })

  it('follows a line inserted right above', () => {
    const diffs = { base: BASE, wc1: WC, wc2: edit(WC, 18, 0, '  // note') }
    expect(relocate(diffs, 17)).toEqual(all(17))
    expect(relocate(diffs, 18)).toEqual(all(19))
    expect(relocate(diffs, 19)).toEqual(all(20))
  })

  it('ignores lines inserted below', () => {
    expect(
      relocate({ base: BASE, wc1: WC, wc2: edit(WC, 19, 0, '  // note') }, 18),
    ).toEqual(all(18))
    expect(relocate({ base: BASE, wc1: WC, wc2: edit(WC, 30, 0, 'x') }, 19)).toEqual(
      all(19),
    )
  })

  it('follows a line with insertions on both sides', () => {
    const wc2 = edit(edit(WC, 19, 0, '  // after'), 18, 0, '  // before')
    expect(relocate({ base: BASE, wc1: WC, wc2 }, 18)).toEqual(all(19))
    expect(relocate({ base: BASE, wc1: WC, wc2 }, 19)).toEqual(all(21))
  })

  it('refuses an edited line', () => {
    expect(
      relocate({ base: BASE, wc1: WC, wc2: edit(WC, 18, 1, '  return 500') }, 18),
    ).toEqual(all(null))
    // Not one of the other `}` lines in view, like f4's at 15.
    expect(relocate({ base: BASE, wc1: WC, wc2: edit(WC, 19, 1, '};') }, 19)).toEqual(
      all(null),
    )
  })

  it('refuses a whitespace-only edit', () => {
    expect(
      relocate({ base: BASE, wc1: WC, wc2: edit(WC, 18, 1, '    return 50') }, 18),
    ).toEqual(all(null))
  })

  it('refuses a deleted line', () => {
    expect(relocate({ base: BASE, wc1: WC, wc2: edit(WC, 18, 1) }, 18)).toEqual(all(null))
    expect(relocate({ base: BASE, wc1: WC, wc2: edit(WC, 19, 1) }, 19)).toEqual(all(null))
  })

  it('refuses a line that moved far away', () => {
    // f5 moved to the end of the file.
    const wc2 = [...edit(WC, 17, 4), ...WC.slice(16, 20)]
    expect(lineText(whole(BASE, wc2), 'additions', 38)).toBe('  return 50')
    expect(relocate({ base: BASE, wc1: WC, wc2 }, 18)).toEqual(all(null))
  })

  it('follows a line whose hunk merged with another', () => {
    // Hunks at 7-13 and 15-21; a line inserted at 14 joins them.
    const wc1 = edit(WC, 10, 1, '  return 30')
    const wc2 = edit(wc1, 14, 0, '// between')
    expect(partial(BASE, wc1).hunks.length).toBe(2)
    expect(partial(BASE, wc2).hunks.length).toBe(1)
    expect(relocate({ base: BASE, wc1, wc2 }, 18)).toEqual(all(19))
    expect(relocate({ base: BASE, wc1, wc2 }, 19)).toEqual(all(20))
  })

  it('follows a line whose hunk split', () => {
    // Edits at 14 and 18 share a hunk until the one at 14 is reverted.
    const wc1 = edit(WC, 14, 1, '  return 40')
    const wc2 = edit(WC, 2, 0, '// one', '// two')
    expect(partial(BASE, wc1).hunks.length).toBe(1)
    expect(partial(BASE, wc2).hunks.length).toBe(2)
    const diffs = { base: BASE, wc1, wc2 }
    expect(relocate(diffs, 18)).toEqual(all(20))
    expect(relocate(diffs, 17)).toEqual(all(19))
    // The reverted line is gone, and f3's `}` is now outside after's hunks.
    expect(relocate(diffs, 14)).toEqual(all(null))
    expect(relocate(diffs, 11)).toEqual({ pp: null, pw: 13, wp: null, ww: 13 })
  })

  it('refuses a line left outside the hunks of a partial after', () => {
    // f5's edit reverted, so line 19 is unchanged far from any change.
    const diffs = { base: BASE, wc1: WC, wc2: edit(BASE, 2, 0, '// top') }
    expect(relocate(diffs, 19)).toEqual({ pp: null, pw: 20, wp: null, ww: 20 })
    expect(relocate(diffs, 18)).toEqual(all(null))
  })

  it('handles the first line of the file', () => {
    const wc1 = edit(BASE, 1, 1, 'function one() {')
    const diffs = { base: BASE, wc1, wc2: edit(wc1, 1, 0, '// header') }
    expect(relocate(diffs, 1)).toEqual(all(2))
    expect(relocate(diffs, 2)).toEqual(all(3))
  })

  it('handles the last line of the file', () => {
    const wc1 = edit(BASE, 40, 1, '// end')
    expect(relocate({ base: BASE, wc1, wc2: [...wc1, 'x'] }, 40)).toEqual(all(40))
    expect(relocate({ base: BASE, wc1, wc2: edit(wc1, 38, 0, 'x') }, 40)).toEqual(all(41))
  })

  it('tells repeated lines apart by their neighbours', () => {
    // g added after f5, then h added between them: two new `}` lines.
    const g = ['function g() {', '  return 0', '}', '']
    const h = ['function h() {', '  return 9', '}', '']
    const wc1 = edit(BASE, 21, 0, ...g)
    const wc2 = edit(BASE, 21, 0, ...h, ...g)
    expect(relocate({ base: BASE, wc1, wc2 }, 23)).toEqual(all(27))
    expect(relocate({ base: BASE, wc1, wc2 }, 22)).toEqual(all(26))
  })

  it('refuses a line duplicated in place', () => {
    const wc1 = edit(BASE, 21, 0, 'dup()')
    const wc2 = edit(BASE, 21, 0, 'dup()', 'dup()')
    expect(relocate({ base: BASE, wc1, wc2 }, 21)).toEqual(all(null))
  })

  it('refuses a line whose match belongs to another line', () => {
    // In a new file, f1 is deleted: f2's `}` is the only one left, but it's
    // f2's, not f1's.
    const diffs = { base: [], wc1: fns(2), wc2: fns(2).slice(4) }
    expect(relocate(diffs, 3)).toEqual(all(null))
    expect(relocate(diffs, 7)).toEqual(all(3))
  })

  it('handles a file that is one repeated line', () => {
    const diffs = { base: [], wc1: xs(14), wc2: xs(16) }
    // A line a few from the start is anchored by it.
    expect(relocate(diffs, 1)).toEqual(all(1))
    expect(relocate(diffs, 3)).toEqual(all(3))
    // Only whole-file diffs know where the file ends. Too far from either
    // end, it's ambiguous.
    expect(relocate(diffs, 14)).toEqual({ pp: null, pw: null, wp: null, ww: 16 })
    expect(relocate(diffs, 8)).toEqual(all(null))
  })

  it('keeps the line when only the base moved', () => {
    // A rebase changed f1 under an otherwise unchanged working copy.
    const diffs = { base: BASE, base2: edit(BASE, 2, 1, '  return one'), wc1: WC, wc2: WC }
    expect(relocate(diffs, 18)).toEqual(all(18))
    expect(relocate(diffs, 19)).toEqual(all(19))
  })

  it('refuses a line once the base moves under an edited file', () => {
    // Without a side shared by both diffs, hunks can't map the line, and the
    // box closes rather than guess.
    const base2 = ['// a', '// b', '// c', ...BASE]
    expect(
      relocate({ base: BASE, base2, wc1: WC, wc2: ['// a', '// b', '// c', ...WC] }, 18),
    ).toEqual(all(null))
    const wc1 = edit(BASE, 18, 1)
    expect(
      relocate({ base: BASE, base2, wc1, wc2: edit(base2, 21, 1) }, 18, 'deletions'),
    ).toEqual(all(null))
  })

  describe('on the deletions side', () => {
    const wc1 = edit(BASE, 18, 1)

    it('keeps a deleted line while the base is unchanged', () => {
      const diffs = { base: BASE, wc1, wc2: edit(wc1, 2, 0, '// one', '// two') }
      expect(relocate(diffs, 18, 'deletions')).toEqual(all(18))
    })

    it('keeps a restored line only where after shows it', () => {
      const diffs = { base: BASE, wc1, wc2: edit(BASE, 2, 0, '// top') }
      expect(relocate(diffs, 18, 'deletions')).toEqual({
        pp: null,
        pw: 18,
        wp: null,
        ww: 18,
      })
    })
  })
})
