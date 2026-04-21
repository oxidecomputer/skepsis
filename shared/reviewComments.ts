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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function reviewTagSource(syntax: CommentSyntax, tag: string): string {
  const prefix = escapeRegex(syntax.prefix)
  const suffix = syntax.suffix ? `(?:\\s*${escapeRegex(syntax.suffix)})?` : ''
  return `${prefix}\\s*${escapeRegex(tag)}${suffix}`
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
