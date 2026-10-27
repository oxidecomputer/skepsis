/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

export type CommentSyntax = { prefix: string; suffix?: string }

export const HASH_COMMENT = { prefix: '#' } as const satisfies CommentSyntax
export const SLASH_COMMENT = { prefix: '//' } as const satisfies CommentSyntax
export const XML_COMMENT = {
  prefix: '<!--',
  suffix: '-->',
} as const satisfies CommentSyntax
export const BLOCK_COMMENT = { prefix: '/*', suffix: '*/' } as const satisfies CommentSyntax
export const DASH_COMMENT = { prefix: '--' } as const satisfies CommentSyntax
export const PERCENT_COMMENT = { prefix: '%' } as const satisfies CommentSyntax
export const SEMICOLON_COMMENT = { prefix: ';' } as const satisfies CommentSyntax
export const QUOTE_COMMENT = { prefix: '"' } as const satisfies CommentSyntax
// Fallback for files where we can't determine a comment syntax (unknown or
// ambiguous file types, or formats with no comment support at all, like CSV).
// Review comments are transient working-copy annotations, so a bare tag that
// isn't a syntactically valid comment is still more useful than refusing to
// insert one.
export const BARE_COMMENT = { prefix: '' } as const satisfies CommentSyntax

export const REVIEW_COMMENT_SYNTAXES = [
  HASH_COMMENT,
  SLASH_COMMENT,
  XML_COMMENT,
  BLOCK_COMMENT,
  DASH_COMMENT,
  PERCENT_COMMENT,
  SEMICOLON_COMMENT,
  QUOTE_COMMENT,
] as const satisfies readonly CommentSyntax[]

export const REVIEW_OPEN_TAG = '<review>'
export const REVIEW_CLOSE_TAG = '</review>'

/** A comment on several lines goes after the last of them, and its open tag
 *  says how many lines it covers, counting up from the tag:
 *  `<review covers="6 lines above">`. A count rather than line numbers, so it
 *  stays right when lines above it are added or removed, including by other
 *  comments. The value is in words because agents read it: in testing,
 *  Sonnet and Haiku sometimes took `above="6"` or `span="6"` to mean line 6,
 *  and never misread this. A plain `<review>` covers the line just above. */
export function reviewOpenTag(lines: number): string {
  return lines > 1 ? `<review covers="${lines} lines above">` : REVIEW_OPEN_TAG
}

// Any attributes are allowed on the open tag, so a comment written with one
// this version doesn't know still shows up as a comment.
const OPEN_TAG_SOURCE = '<review(?:\\s+[\\w-]+="[^"]*")*\\s*>'
const OPEN_TAG_RE = new RegExp(OPEN_TAG_SOURCE)

/** The attributes on an open tag line. */
export function reviewOpenTagAttributes(line: string): Record<string, string> {
  const tag = line.match(OPEN_TAG_RE)?.[0] ?? ''
  return Object.fromEntries(
    Array.from(tag.matchAll(/([\w-]+)="([^"]*)"/g), (m) => [m[1], m[2]]),
  )
}

/** How many lines above it an open tag line covers (see reviewOpenTag). */
export function reviewOpenTagLines(line: string): number {
  const n = reviewOpenTagAttributes(line)['covers']?.match(/^(\d+) lines above$/)?.[1]
  return n ? Math.max(1, parseInt(n, 10)) : 1
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The open tag may carry attributes (see OPEN_TAG_SOURCE).
function tagSource(tag: string): string {
  return tag === REVIEW_OPEN_TAG ? OPEN_TAG_SOURCE : escapeRegex(tag)
}

function reviewTagSource(syntax: CommentSyntax, tag: string): string {
  const prefix = escapeRegex(syntax.prefix)
  const suffix = syntax.suffix ? `(?:\\s*${escapeRegex(syntax.suffix)})?` : ''
  return `${prefix}\\s*${tagSource(tag)}${suffix}`
}

export function reviewTagRegex(syntax: CommentSyntax, tag: string): RegExp {
  return new RegExp(`^\\s*${reviewTagSource(syntax, tag)}\\s*$`)
}

export function anyReviewTagRegex(syntaxes: readonly CommentSyntax[], tag: string): RegExp {
  const body = syntaxes.map((syntax) => reviewTagSource(syntax, tag)).join('|')
  return new RegExp(`^\\s*(?:${body})\\s*$`)
}

export const REVIEW_OPEN_PATTERN = anyReviewTagRegex(
  REVIEW_COMMENT_SYNTAXES,
  REVIEW_OPEN_TAG,
)
export const REVIEW_CLOSE_PATTERN = anyReviewTagRegex(
  REVIEW_COMMENT_SYNTAXES,
  REVIEW_CLOSE_TAG,
)

// Deliberately not part of the patterns above: a bare tag line could appear as
// genuine content in a normal file (e.g. a literal <review> element in an XML
// fixture), so the client applies these only to files the server has flagged
// as getting the bare fallback.
export const BARE_REVIEW_OPEN_PATTERN = reviewTagRegex(BARE_COMMENT, REVIEW_OPEN_TAG)
export const BARE_REVIEW_CLOSE_PATTERN = reviewTagRegex(BARE_COMMENT, REVIEW_CLOSE_TAG)
