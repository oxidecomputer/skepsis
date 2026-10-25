/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Keeps an open comment box on its line when the diff under it is refetched.
 *
 * Line numbers alone drift as soon as lines are added above, and matching on
 * text alone jumps between the many `}` and blank lines a file repeats. A
 * partial diff also hides most of the file, so a text match can land on a
 * visible copy of the line while the real one has left the hunks. So
 * relocateLine leans on what the two diffs share, in order of strength:
 *
 * 1. The line's own side is unchanged (same blob): the line hasn't moved.
 * 2. The other side is unchanged, normally the base: diff hunks map lines
 *    exactly through it. A line that was unchanged in `before` maps to its
 *    base line and on to `after`, or into the change block that replaced it
 *    there. A line that was itself added maps to the stretch of `after`
 *    between the base lines that bracketed its block. Only that stretch is
 *    searched for the line's text, so a far-off copy can't win.
 *
 * Neither (a commit or rebase under an edited file) gives null, as does an
 * edit to the line itself, a deletion, or a move outside that stretch.
 * Several candidates are told apart by how many neighbouring lines above and
 * below also match, ignoring whitespace, with the file's start and end
 * counting as matches. A tie is refused rather than guessed, and the match
 * has to hold both ways: the line found must pick `line` as its own best
 * match back in `before`. Otherwise deleting a function would move a box on
 * its `}` to the next function's `}`, the only one left in the stretch.
 */

import type { FileDiffMetadata, Hunk } from '@pierre/diffs'

type Side = 'additions' | 'deletions'

const otherSide = (side: Side): Side => (side === 'additions' ? 'deletions' : 'additions')

const sideLines = (file: FileDiffMetadata, side: Side) =>
  side === 'additions' ? file.additionLines : file.deletionLines

const stripEol = (line: string) => line.replace(/\r?\n$/, '')
const loose = (line: string) => line.trim().replace(/\s+/g, ' ')

/** A run of line numbers on one side of a diff. */
interface Span {
  start: number
  count: number
}

const lastOf = (s: Span) => s.start + s.count - 1

/** A hunk's lines on one side. A header count of 0 gives the line before. */
function hunkSpan(hunk: Hunk, side: Side): Span {
  const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart
  const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount
  return { start: count === 0 ? start + 1 : start, count }
}

/**
 * The text of line `line` (1-based, in that side's file numbering) if the
 * diff shows it, else undefined. Line endings are stripped.
 */
export function lineText(
  file: FileDiffMetadata,
  side: Side,
  line: number,
): string | undefined {
  const lines = sideLines(file, side)
  // A whole-file diff holds every line, hunks or not.
  if (!file.isPartial)
    return line >= 1 && line <= lines.length ? stripEol(lines[line - 1]!) : undefined
  // A partial one holds only hunk lines, packed hunk after hunk.
  for (const hunk of file.hunks) {
    const span = hunkSpan(hunk, side)
    if (line >= span.start && line < span.start + span.count) {
      const index = side === 'additions' ? hunk.additionLineIndex : hunk.deletionLineIndex
      return stripEol(lines[index + line - span.start]!)
    }
  }
  return undefined
}

/** Every line the diff shows on a side, as [line number, text]. */
function* knownLines(file: FileDiffMetadata, side: Side): Generator<[number, string]> {
  if (!file.isPartial) {
    const lines = sideLines(file, side)
    for (let i = 0; i < lines.length; i++) yield [i + 1, stripEol(lines[i]!)]
    return
  }
  for (const hunk of file.hunks) {
    const span = hunkSpan(hunk, side)
    for (let n = span.start; n < span.start + span.count; n++)
      yield [n, lineText(file, side, n)!]
  }
}

const START = Symbol('start of file')
const END = Symbol('end of file')

/** lineText, with markers past either end of the file where that's known. */
function textAt(file: FileDiffMetadata, side: Side, line: number) {
  if (line < 1) return START
  if (!file.isPartial && line > sideLines(file, side).length) return END
  return lineText(file, side, line)
}

/**
 * Where a line on one side of a diff sits on the other side: a line number if
 * the line is unchanged (including lines between hunks, and the virtual lines
 * before and after the file), or the change block it's part of, as its span
 * on each side.
 */
type Location = { line: number } | { block: Span; other: Span }

function locate(file: FileDiffMetadata, side: Side, line: number): Location {
  const other = otherSide(side)
  // The next line after the last hunk passed, on each side.
  let next = 1
  let otherNext = 1
  for (const hunk of file.hunks) {
    const span = hunkSpan(hunk, side)
    if (line < span.start) break
    let at = span.start
    let otherAt = hunkSpan(hunk, other).start
    for (const content of hunk.hunkContent) {
      const [len, otherLen] =
        content.type === 'context'
          ? [content.lines, content.lines]
          : side === 'additions'
            ? [content.additions, content.deletions]
            : [content.deletions, content.additions]
      if (line >= at && line < at + len) {
        return content.type === 'context'
          ? { line: otherAt + line - at }
          : { block: { start: at, count: len }, other: { start: otherAt, count: otherLen } }
      }
      at += len
      otherAt += otherLen
    }
    next = at
    otherNext = otherAt
  }
  return { line: otherNext + line - next }
}

/**
 * How many lines above and below `line` in `before` match those around
 * `candidate` in `after`, compared ignoring whitespace, up to a few each way.
 */
function contextScore(
  before: FileDiffMetadata,
  after: FileDiffMetadata,
  side: Side,
  line: number,
  candidate: number,
): [number, number] {
  const reach = 5
  const count = (step: number) => {
    for (let d = 1; d <= reach; d++) {
      const a = textAt(before, side, line + step * d)
      const b = textAt(after, side, candidate + step * d)
      if (a === undefined || b === undefined) return d - 1
      // Both at the same end of the file: everything past it agrees too.
      if (typeof a === 'symbol' || typeof b === 'symbol') return a === b ? reach : d - 1
      if (loose(a) !== loose(b)) return d - 1
    }
    return reach
  }
  return [count(-1), count(1)]
}

/**
 * The line in `after` within [lo, hi] with the same text as `line` of
 * `before` and the most matching context. null for none or a tie.
 */
function bestMatch(
  before: FileDiffMetadata,
  after: FileDiffMetadata,
  side: Side,
  line: number,
  [lo, hi]: [number, number],
): number | null {
  const text = lineText(before, side, line)
  let best: number | null = null
  let bestScore = -1
  for (const [n, t] of knownLines(after, side)) {
    if (n < lo || n > hi || t !== text) continue
    const [above, below] = contextScore(before, after, side, line, n)
    if (above + below > bestScore) [best, bestScore] = [n, above + below]
    else if (above + below === bestScore) best = null
  }
  return best
}

/**
 * Whether a side's file content is the same in both diffs, by object ID
 * (patch IDs can be abbreviated). The app copies the patch's IDs onto the
 * whole-file diffs it builds, which parseDiffFromFile leaves without.
 */
function sameContent(a: FileDiffMetadata, b: FileDiffMetadata, side: Side): boolean {
  const idA = side === 'additions' ? a.newObjectId : a.prevObjectId
  const idB = side === 'additions' ? b.newObjectId : b.prevObjectId
  return !!idA && !!idB && (idA.startsWith(idB) || idB.startsWith(idA))
}

/** The lines of `after` that line `line` of `before` maps to through the other side. */
function mappedRange(
  before: FileDiffMetadata,
  after: FileDiffMetadata,
  side: Side,
  line: number,
): [number, number] {
  const pivot = otherSide(side)
  const here = locate(before, side, line)
  if ('line' in here) {
    // Unchanged in before: follow its base line, or take the block that
    // replaced it.
    const there = locate(after, pivot, here.line)
    return 'line' in there
      ? [there.line, there.line]
      : [there.other.start, lastOf(there.other)]
  }
  // Part of a change: whatever after has between the base lines on either
  // side of that change, plus any change blocks that took those lines too.
  const above = locate(after, pivot, here.other.start - 1)
  const below = locate(after, pivot, here.other.start + here.other.count)
  return [
    'line' in above ? above.line + 1 : above.other.start,
    'line' in below ? below.line - 1 : lastOf(below.other),
  ]
}

/**
 * Where line `line` of `before` is in `after`, both diffs of the same file
 * path. null when it can't be placed with confidence (the line was deleted or
 * edited, or the match is ambiguous), or `after` doesn't show it.
 */
export function relocateLine(
  before: FileDiffMetadata,
  after: FileDiffMetadata,
  side: Side,
  line: number,
): number | null {
  const text = lineText(before, side, line)
  if (text === undefined) return null
  if (sameContent(before, after, side))
    return lineText(after, side, line) === text ? line : null
  if (!sameContent(before, after, otherSide(side))) return null
  const found = bestMatch(before, after, side, line, mappedRange(before, after, side, line))
  if (found === null) return null
  const back = bestMatch(
    after,
    before,
    side,
    found,
    mappedRange(after, before, side, found),
  )
  return back === line ? found : null
}
