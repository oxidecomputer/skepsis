/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { join } from 'node:path'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { commentSyntaxAt, getCommentSyntax } from './commentSyntax.ts'
import {
  BARE_COMMENT,
  REVIEW_CLOSE_TAG,
  REVIEW_OPEN_TAG,
  reviewOpenTag,
  reviewTagRegex,
} from '../shared/reviewComments.ts'

/**
 * Comments are inserted as lines into the file itself. Writing through a
 * symlink would silently edit the link's target instead, so the server
 * refuses. The client surfaces the error in the comment form.
 */
async function assertNotSymlink(cwd: string, file: string): Promise<void> {
  const stat = await lstat(join(cwd, file)).catch(() => null)
  if (stat?.isSymbolicLink()) {
    throw new Error(`Cannot comment on symlink: ${file}`)
  }
}

export async function insertComment(
  cwd: string,
  file: string,
  afterLine: number,
  lineText: string,
  text: string,
  lineCount = 1,
): Promise<void> {
  await assertNotSymlink(cwd, file)
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  if (afterLine < 1 || afterLine > lines.length) {
    throw new Error(`Line ${afterLine} out of range (file has ${lines.length} lines)`)
  }

  const targetLine = lines[afterLine - 1]!
  if (targetLine.replace(/\r$/, '') !== lineText.replace(/\r?\n$/, '')) {
    throw new Error(`Line ${afterLine} changed on disk. Refresh and try again.`)
  }

  // Match indentation of the target line
  const indent = targetLine.match(/^(\s*)/)?.[1] ?? ''
  const { prefix, suffix } = commentSyntaxAt(file, lines, afterLine)
  // Text containing the comment's close delimiter would end the comment
  // early, so break the delimiter up with a space. `{/* */}` ends at `*/`.
  const close = suffix?.replace(/}$/, '')
  const escape = (body: string) =>
    close ? body.replaceAll(close, `${close.slice(0, -1)} ${close.slice(-1)}`) : body
  // prefix may be empty (bare fallback for unknown file types), so join only
  // the non-empty parts
  const wrap = (body: string) =>
    indent + [prefix, escape(body), suffix].filter(Boolean).join(' ')

  const commentLines = [
    // The covered lines end at afterLine, so they can't start before line 1
    wrap(reviewOpenTag(Math.min(lineCount, afterLine))),
    ...text.split('\n').map((line) => wrap(line)),
    wrap(REVIEW_CLOSE_TAG),
  ]

  lines.splice(afterLine, 0, ...commentLines)
  await writeFile(filePath, lines.join('\n'))
}

export async function removeComment(
  cwd: string,
  file: string,
  line: number,
): Promise<void> {
  await assertNotSymlink(cwd, file)
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range`)
  }

  // Take the marker from the open tag rather than recomputing the section:
  // a sectioned file's comment may predate an edit that moved it, or an
  // older version that always used `//`.
  const fileSyntax = getCommentSyntax(file, lines[0] ?? '')
  const candidates =
    fileSyntax && 'sections' in fileSyntax
      ? Object.values(fileSyntax.sections)
      : [fileSyntax ?? BARE_COMMENT]
  const syntax = candidates.find((s) =>
    reviewTagRegex(s, REVIEW_OPEN_TAG).test(lines[line - 1]!),
  )
  if (!syntax) throw new Error(`Line ${line} is not a <review> open tag`)
  const closeRe = reviewTagRegex(syntax, REVIEW_CLOSE_TAG)

  let end = line
  while (end < lines.length && !closeRe.test(lines[end]!)) end++
  if (end >= lines.length) {
    throw new Error(`No </review> close tag found after line ${line}`)
  }

  lines.splice(line - 1, end - line + 2)
  await writeFile(filePath, lines.join('\n'))
}
