/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { open } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Language, LanguageName } from 'linguist-languages'
import * as languages from 'linguist-languages'
import { parser } from '@lezer/javascript'
import {
  BARE_COMMENT,
  BLOCK_COMMENT,
  type CommentSyntax,
  DASH_COMMENT,
  type FileCommentSyntax,
  JSX_COMMENT,
  HASH_COMMENT,
  PERCENT_COMMENT,
  QUOTE_COMMENT,
  JSX_SECTIONS,
  SFC_SECTIONS,
  VUE_SECTIONS,
  SEMICOLON_COMMENT,
  SLASH_COMMENT,
  XML_COMMENT,
} from '../shared/reviewComments.ts'

// Hand-maintained table of linguist language name → line-comment syntax,
// grouped by syntax to make the source of truth compact. If a language
// detected via linguist isn't listed here, we fall back to bare (uncommented)
// review tags rather than guessing a syntax.
const SYNTAX_GROUPS: Array<[Exclude<FileCommentSyntax, null>, LanguageName[]]> = [
  [
    HASH_COMMENT,
    [
      'Shell',
      'Python',
      'Ruby',
      'Perl',
      'MiniYAML',
      'YAML',
      'TOML',
      'Git Config',
      'Git Attributes',
      'Makefile',
      'Dockerfile',
      'Nix',
      'Nushell',
      'fish',
      'R',
      'Elixir',
      'Ignore List',
    ],
  ],
  [
    SLASH_COMMENT,
    [
      'JavaScript',
      'TypeScript',
      'Go',
      'Rust',
      'Java',
      'Kotlin',
      'Swift',
      'C',
      'C++',
      'C#',
      'Scala',
      'Dart',
      'PHP',
      'Zig',
      'JSON5',
      'JSON with Comments',
      // JSON doesn't support comments, but the user opted in; '//' produces
      // invalid JSON that most editors still highlight recognizably.
      'JSON',
    ],
  ],
  [SFC_SECTIONS, ['Svelte', 'Astro', 'HTML']],
  [VUE_SECTIONS, ['Vue']],
  [JSX_SECTIONS, ['TSX']],
  [XML_COMMENT, ['XML', 'SVG', 'Markdown']],
  // MDX 2 and later reject HTML comments
  [JSX_COMMENT, ['MDX']],
  [BLOCK_COMMENT, ['CSS', 'SCSS', 'Less']],
  [DASH_COMMENT, ['SQL', 'Lua', 'Haskell']],
  [PERCENT_COMMENT, ['TeX', 'Erlang']],
  // 'Nu' is the Lisp-like build system (`;` comments); 'Nushell' is the shell (`#` comments).
  [SEMICOLON_COMMENT, ['INI', 'Emacs Lisp', 'Common Lisp', 'Clojure', 'Scheme', 'Nu']],
  [QUOTE_COMMENT, ['Vim script']],
  // Formats with no comment syntax at all: insert review tags bare. Listed
  // here (unlike unknown file types, which get the same bare tags as a
  // fallback) so the UI can say "no marker" is the correct answer rather than
  // a guess.
  [BARE_COMMENT, ['Text', 'CSV', 'TSV']],
]

const COMMENT_SYNTAX = new Map<LanguageName, Exclude<FileCommentSyntax, null>>(
  SYNTAX_GROUPS.flatMap(([syntax, langs]) => langs.map((l) => [l, syntax] as const)),
)

// Linguist lists multiple languages for the same extension; there's no
// disambiguation metadata exposed, so pin the common collisions by hand.
const EXTENSION_OVERRIDES: Partial<Record<string, LanguageName>> = {
  '.md': 'Markdown',
  '.html': 'HTML',
  '.tsx': 'TSX',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.sql': 'SQL',
  '.h': 'C',
  '.nu': 'Nushell',
  '.pl': 'Perl',
  '.r': 'R',
  '.rs': 'Rust',
  '.ts': 'TypeScript',
  '.cls': 'TeX',
  '.php': 'PHP',
  '.cs': 'C#',
  '.txt': 'Text',
}

const EXTENSION_SYNTAX_OVERRIDES: Partial<Record<string, FileCommentSyntax>> = {
  // linguist calls these JavaScript, which also covers .js files with no JSX
  '.jsx': JSX_SECTIONS,
  '.conf': HASH_COMMENT,
}

const allLanguages = Object.values(languages) as Language[]

const byFilename = new Map<string, Language>()
const byExtension = new Map<string, Language>()
const ambiguousExtensions = new Set<string>()
const byInterpreter = new Map<string, Language>()

for (const lang of allLanguages) {
  for (const f of lang.filenames ?? []) byFilename.set(f.toLowerCase(), lang)
  for (const e of lang.extensions ?? []) {
    const ext = e.toLowerCase()
    if (ambiguousExtensions.has(ext)) continue
    const prior = byExtension.get(ext)
    if (!prior) {
      byExtension.set(ext, lang)
    } else if (prior.name !== lang.name) {
      byExtension.delete(ext)
      ambiguousExtensions.add(ext)
    }
  }
  for (const i of lang.interpreters ?? []) {
    if (!byInterpreter.has(i)) byInterpreter.set(i, lang)
  }
}

function shebangInterpreter(firstLine: string): string | null {
  if (!firstLine.startsWith('#!')) return null
  const parts = firstLine.slice(2).trim().split(/\s+/)
  const command = parts[0]?.split('/').pop()
  if (command !== 'env') return command ?? null
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    if (part && !part.startsWith('-')) return part.split('/').pop() ?? null
  }
  return null
}

export function detectLanguage(file: string, firstLine: string): LanguageName | null {
  const base = basename(file).toLowerCase()
  const hit = byFilename.get(base)
  if (hit) return hit.name

  const ext = extname(base)
  if (ext) {
    const override = EXTENSION_OVERRIDES[ext]
    if (override) return override
    const extHit = byExtension.get(ext)
    if (extHit) return extHit.name
  }

  const interp = shebangInterpreter(firstLine)
  if (interp) {
    const iHit = byInterpreter.get(interp)
    if (iHit) return iHit.name
  }

  return null
}

/** Null means the file type couldn't be determined (or has no table entry);
 *  callers that insert comments fall back to bare tags, and the UI can
 *  distinguish "unknown, so no marker" from a known-markerless format. */
export function getCommentSyntax(file: string, firstLine: string): FileCommentSyntax {
  const base = basename(file).toLowerCase()
  const ext = extname(base)
  const syntaxOverride = EXTENSION_SYNTAX_OVERRIDES[ext]
  if (syntaxOverride) return syntaxOverride

  const lang = detectLanguage(file, firstLine)
  if (!lang) return null
  return COMMENT_SYNTAX.get(lang) ?? null
}

// Consume whole tags, including quoted attributes, so a <style> or > inside
// an attribute cannot start a section or end the surrounding tag.
const MARKUP_TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][\w:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g

/** The section containing `offset`, with the full script/style content range.
 *  In markup, skip comments and ordinary tags. Script/style content is raw
 *  text that only its complete close tag ends. HTML names ignore case; in
 *  components, <Style> and <script-editor> are ordinary elements. */
function sfcSectionAt(
  text: string,
  offset: number,
  html: boolean,
): {
  section: keyof typeof SFC_SECTIONS.sections
  openTag: string
  contentStart: number
  contentEnd: number
} {
  let pos = 0
  for (;;) {
    MARKUP_TOKEN.lastIndex = pos
    const token = MARKUP_TOKEN.exec(text)
    if (!token || MARKUP_TOKEN.lastIndex > offset) {
      return { section: 'markup', openTag: '', contentStart: 0, contentEnd: 0 }
    }
    pos = MARKUP_TOKEN.lastIndex
    const tag = html ? token[1]?.toLowerCase() : token[1]
    if (tag !== 'script' && tag !== 'style') continue
    if (token[0].startsWith('</') || token[0].endsWith('/>')) continue
    const closeTag = new RegExp(`</${tag}(?=[\\s/>])[^>]*>`, html ? 'gi' : 'g')
    closeTag.lastIndex = pos
    const close = closeTag.exec(text)
    if (!close || closeTag.lastIndex > offset) {
      return {
        section: tag,
        openTag: token[0],
        contentStart: pos,
        contentEnd: close?.index ?? text.length,
      }
    }
    pos = closeTag.lastIndex
  }
}

function scriptUsesJsx(openTag: string): boolean {
  // Consume each whole attribute so lang-like text inside another value is skipped.
  const attributes = openTag.matchAll(
    /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
  )
  for (const [, name, double, single, bare] of attributes) {
    if (name === 'lang') return /^(jsx|tsx)$/.test(double ?? single ?? bare ?? '')
  }
  return false
}

/** The marker for a comment inserted after line `afterLine` of a file. */
export function commentSyntaxAt(
  file: string,
  lines: string[],
  afterLine: number,
): CommentSyntax {
  const syntax = getCommentSyntax(file, lines[0] ?? '')
  if (!syntax || !('sections' in syntax)) return syntax ?? BARE_COMMENT
  if (syntax === JSX_SECTIONS) {
    const offset = lines.slice(0, afterLine).join('\n').length + 1
    return inJsxChildren(lines.join('\n'), offset) ? JSX_COMMENT : SLASH_COMMENT
  }
  const sections = SFC_SECTIONS.sections
  const language = detectLanguage(file, '')
  // An Astro component starts with its TypeScript between `---` fences.
  let markupStart = 0
  if (language === 'Astro' && lines[0]?.trim() === '---') {
    const fence = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    if (fence !== -1) {
      if (afterLine >= 1 && afterLine <= fence) return sections.script
      markupStart = fence + 1
    }
  }
  const text = lines.slice(markupStart).join('\n')
  const offset = lines.slice(markupStart, afterLine).join('\n').length + 1
  const { section, openTag, contentStart, contentEnd } = sfcSectionAt(
    text,
    offset,
    language === 'HTML',
  )
  if (syntax === VUE_SECTIONS && section === 'script' && scriptUsesJsx(openTag)) {
    const code = text.slice(contentStart, contentEnd)
    if (inJsxChildren(code, offset - contentStart)) return JSX_COMMENT
  }
  return sections[section]
}

const tsxParser = parser.configure({ dialect: 'ts jsx' })

/** Whether a line inserted at `offset` in `code` lands among JSX children,
 *  where `//` would render as text and only `{/* *\/}` is a comment. Between
 *  attributes in a tag and in JS inside `{}`, `//` works. Lezer recovers from
 *  syntax errors so an unrelated edit doesn't hide the JSX context. */
function inJsxChildren(code: string, offset: number): boolean {
  // Side 0 enters only nodes covering the point on both sides: at the start
  // of a child tag or expression, the comment still belongs to its parent.
  const { name } = tsxParser.parse(code).resolveInner(offset, 0)
  // Fragments are JSXElement nodes too.
  return name === 'JSXElement' || name === 'JSXText'
}

// A shebang line is well under this, and the first line is only used for
// shebang detection.
const FIRST_LINE_BYTES = 256

async function readFirstLine(path: string): Promise<string> {
  const fh = await open(path)
  try {
    const buf = Buffer.alloc(FIRST_LINE_BYTES)
    const { bytesRead } = await fh.read(buf, 0, FIRST_LINE_BYTES, 0)
    const text = buf.subarray(0, bytesRead).toString('utf-8')
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  } finally {
    await fh.close()
  }
}

/** Resolve the comment syntax for each of `files` (null = unknown file type,
 *  which gets the bare fallback on insert). */
export async function getCommentSyntaxes(
  cwd: string,
  files: string[],
): Promise<Record<string, FileCommentSyntax>> {
  const result: Record<string, FileCommentSyntax> = {}
  await Promise.all(
    files.map(async (file) => {
      // Filename and extension detection don't need the first line; only read
      // files (for shebang detection) when those come up empty. Unreadable
      // (e.g. deleted) files resolve to unknown; they have no addition lines
      // to comment on, so the value is inert.
      let syntax = getCommentSyntax(file, '')
      if (syntax === null) {
        const firstLine = await readFirstLine(join(cwd, file)).catch(() => '')
        syntax = getCommentSyntax(file, firstLine)
      }
      result[file] = syntax
    }),
  )
  return result
}
