/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { getCommentSyntax } from './commentSyntax.ts'
import {
  REVIEW_CLOSE_TAG,
  REVIEW_OPEN_TAG,
  reviewTagRegex,
} from '../shared/reviewComments.ts'

export async function insertComment(
  cwd: string,
  file: string,
  afterLine: number,
  text: string,
): Promise<void> {
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  if (afterLine < 1 || afterLine > lines.length) {
    throw new Error(`Line ${afterLine} out of range (file has ${lines.length} lines)`)
  }

  // Match indentation of the target line
  const targetLine = lines[afterLine - 1]!
  const indent = targetLine.match(/^(\s*)/)?.[1] ?? ''
  const { prefix, suffix } = getCommentSyntax(file, lines[0] ?? '')
  const wrap = (body: string) => {
    if (!body) return suffix ? `${indent}${prefix} ${suffix}` : `${indent}${prefix}`
    return suffix ? `${indent}${prefix} ${body} ${suffix}` : `${indent}${prefix} ${body}`
  }

  const commentLines = [
    wrap(REVIEW_OPEN_TAG),
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
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range`)
  }

  const syntax = getCommentSyntax(file, lines[0] ?? '')
  const openRe = reviewTagRegex(syntax, REVIEW_OPEN_TAG)
  const closeRe = reviewTagRegex(syntax, REVIEW_CLOSE_TAG)

  if (!openRe.test(lines[line - 1]!)) {
    throw new Error(`Line ${line} is not a <review> open tag`)
  }

  let end = line
  while (end < lines.length && !closeRe.test(lines[end]!)) end++
  if (end >= lines.length) {
    throw new Error(`No </review> close tag found after line ${line}`)
  }

  lines.splice(line - 1, end - line + 2)
  await writeFile(filePath, lines.join('\n'))
}
