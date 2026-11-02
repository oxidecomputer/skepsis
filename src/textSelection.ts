/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// Text selections in the diff, for comments on part of a line (--send only).
// Each diff item renders in its own shadow root as rows of
// `[data-line]` elements, one per line, holding the line's text. A row's
// `data-line` is its number in its own side's numbering.

type Side = 'additions' | 'deletions'

/** A selection in one side of one item: from column `columns[0]` of line
 *  `first` to column `columns[1]` (exclusive) of line `last`. */
export type TextAnchor = {
  host: Element
  side: Side
  first: number
  last: number
  columns: [number, number]
}

// In split mode each side has its own column; in unified mode, deletion rows
// are mixed in with the rest.
const sideOf = (row: Element): Side =>
  row.getAttribute('data-line-type') === 'change-deletion' ||
  row.closest('[data-deletions]')
    ? 'deletions'
    : 'additions'

/** The rows of `side` in the column `row` is in, in order. */
function sideRows(row: Element, side: Side): Element[] {
  const column = row.closest('[data-code]')
  if (!column) return []
  return [...column.querySelectorAll('[data-content] > [data-line]')].filter(
    (r) => sideOf(r) === side,
  )
}

const elementOf = (node: Node) => (node instanceof Element ? node : node.parentElement)

/** The length of `row`'s text, without the newline an empty row holds */
const textLength = (row: Element) => (row.textContent ?? '').replace(/\n$/, '').length

/** The column of a point in `row`'s text. */
function columnOf(row: Element, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(row, 0)
  range.setEnd(node, offset)
  return range.toString().length
}

/** A point as a place in `root`'s tree. The item's annotations (comment boxes
 *  and such) are in the page's tree, slotted into the item, so a point in one
 *  is at its slot. Null for a point outside the item. */
function pointIn(root: ShadowRoot, node: Node, offset: number): [Node, number] | null {
  if (node.getRootNode() === root) return [node, offset]
  let child: Node | null = node
  while (child && child.parentNode !== root.host) child = child.parentNode
  const slot = child instanceof Element || child instanceof Text ? child.assignedSlot : null
  return slot ? [slot, 0] : null
}

/** The page's selection, if it starts in a diff row: cut down to the rows of
 *  that row's side, up to where it ends or the column runs out. Ending at the
 *  very start of a row is ending at the end of the row before, and starting
 *  at the very end of a row (or on an empty one) is starting on the next. */
export function selectionAnchor(hosts: Element[]): TextAnchor | null {
  const selection = window.getSelection()
  const shadowRoots = hosts.flatMap((h) => (h.shadowRoot ? [h.shadowRoot] : []))
  // Not selection.isCollapsed: Chrome says true for a selection in a shadow root
  if (!selection?.getComposedRanges) return null
  const [r] = selection.getComposedRanges({ shadowRoots })
  if (!r || r.collapsed) return null
  const start = elementOf(r.startContainer)?.closest('[data-line]')
  const root = start?.getRootNode()
  if (!start || !(root instanceof ShadowRoot) || !hosts.includes(root.host)) return null

  const side = sideOf(start)
  const rows = sideRows(start, side)
  // Rows from `start` on that come before the selection's end. An end in
  // another item runs to the end of this one.
  const endPoint = pointIn(root, r.endContainer, r.endOffset)
  const end = endPoint && document.createRange()
  end?.setStart(...endPoint!)
  // In split mode, an end in the other side's column stays on the start row,
  // as a gutter drag across sides does
  const endIn = endPoint && elementOf(endPoint[0])?.closest('[data-code]')
  const crossColumn = endIn && endIn !== start.closest('[data-code]')
  const before = (row: Element) => !crossColumn && (!end || end.comparePoint(row, 0) < 0)
  let firstIndex = rows.indexOf(start)
  let lastIndex = firstIndex
  while (lastIndex + 1 < rows.length && before(rows[lastIndex + 1]!)) lastIndex++
  let endColumn = rows[lastIndex]!.contains(r.endContainer)
    ? columnOf(rows[lastIndex]!, r.endContainer, r.endOffset)
    : Infinity
  if (endColumn === 0 && lastIndex > firstIndex) {
    lastIndex--
    endColumn = Infinity
  }
  let startColumn = columnOf(start, r.startContainer, r.startOffset)
  while (firstIndex < lastIndex && startColumn >= textLength(rows[firstIndex]!)) {
    firstIndex++
    startColumn = 0
  }
  return {
    host: root.host,
    side,
    first: Number(rows[firstIndex]!.getAttribute('data-line')),
    last: Number(rows[lastIndex]!.getAttribute('data-line')),
    columns: [startColumn, endColumn],
  }
}

/** The point at `column` in `row`'s text. */
function pointAt(row: Element, column: number): [Node, number] {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let rest = column
  let node: Text | null = null
  while ((node = walker.nextNode() as Text | null)) {
    if (rest <= node.length) return [node, rest]
    rest -= node.length
  }
  return [row, row.childNodes.length]
}

/** A range over the text a comment is on, in `host`'s rendered rows, or null
 *  when the rows aren't rendered. */
export function textRange(
  host: Element,
  side: Side,
  first: number,
  last: number,
  [startColumn, endColumn]: [number, number],
): Range | null {
  const rows = [
    ...(host.shadowRoot?.querySelectorAll('[data-content] > [data-line]') ?? []),
  ]
  const find = (line: number) =>
    rows.find((r) => sideOf(r) === side && r.getAttribute('data-line') === String(line))
  const start = find(first)
  const end = find(last)
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(...pointAt(start, startColumn))
  range.setEnd(...pointAt(end, endColumn))
  return range
}

/** Put a `<slot name={name}>` in the line `range` ends in, after the visual
 *  row it ends on (in wrapped text, the screen line), so what's slotted there
 *  shows between that row and the next. Moves the slot only when it isn't
 *  there already, since moving it takes focus from what it shows. */
export function openLineAt(root: ShadowRoot, range: Range, name: string) {
  const row = elementOf(range.endContainer)?.closest('[data-line]')
  if (!row) return
  // The first character on a lower row than the range's end
  const rects = range.getClientRects()
  const bottom = rects[rects.length - 1]?.bottom ?? 0
  // (A range that doesn't end in text ends at the end of the line.)
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  walker.currentNode = range.endContainer
  const char = document.createRange()
  let at: [Text, number] | null = null
  let text = range.endContainer instanceof Text ? range.endContainer : null
  let i = range.endOffset
  while (text && !at) {
    for (; i < text.length; i++) {
      char.setStart(text, i)
      char.setEnd(text, i + 1)
      const r = char.getBoundingClientRect()
      if (r.height > 0 && r.top >= bottom - 1) {
        at = [text, i]
        break
      }
    }
    text = walker.nextNode() as Text | null
    i = 0
  }
  const key = at ? `${columnOf(row, ...at)}` : 'end'
  const old = root.querySelector<HTMLSlotElement>(`slot[name="${name}"]`)
  if (old && row.contains(old) && old.dataset['at'] === key) return
  old?.remove()
  const slot = document.createElement('slot')
  slot.name = name
  slot.dataset['at'] = key
  if (!at) row.append(slot)
  else if (at[1] === 0) at[0].before(slot)
  else at[0].splitText(at[1]).before(slot)
}

/** Take out the slot `openLineAt` put in. */
export function closeLine(root: ShadowRoot, name: string) {
  root.querySelector(`slot[name="${name}"]`)?.remove()
}
