/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { basename, extname } from 'node:path'
import * as languages from 'linguist-languages'
import type { Language, LanguageName } from 'linguist-languages'
import {
  BLOCK_COMMENT,
  DASH_COMMENT,
  HASH_COMMENT,
  PERCENT_COMMENT,
  QUOTE_COMMENT,
  SEMICOLON_COMMENT,
  SLASH_COMMENT,
  XML_COMMENT,
  type CommentSyntax,
} from '../shared/reviewComments.ts'

// Hand-maintained table of linguist language name → line-comment syntax,
// grouped by syntax to make the source of truth compact. If a language
// detected via linguist isn't listed here, we treat the file as unsupported
// rather than guessing.
const SYNTAX_GROUPS: Array<[CommentSyntax, LanguageName[]]> = [
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
      'TSX',
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
      'Zig',
      'JSON5',
      'JSON with Comments',
      // JSON doesn't support comments, but the user opted in; '//' produces
      // invalid JSON that most editors still highlight recognizably.
      'JSON',
    ],
  ],
  [XML_COMMENT, ['HTML', 'XML', 'SVG', 'Markdown', 'MDX']],
  [BLOCK_COMMENT, ['CSS', 'SCSS', 'Less']],
  [DASH_COMMENT, ['SQL', 'Lua', 'Haskell']],
  [PERCENT_COMMENT, ['TeX', 'Erlang']],
  // 'Nu' is the Lisp-like build system (`;` comments); 'Nushell' is the shell (`#` comments).
  [SEMICOLON_COMMENT, ['INI', 'Emacs Lisp', 'Common Lisp', 'Clojure', 'Scheme', 'Nu']],
  [QUOTE_COMMENT, ['Vim Script']],
]

const COMMENT_SYNTAX = new Map<LanguageName, CommentSyntax>(
  SYNTAX_GROUPS.flatMap(([syntax, langs]) => langs.map((l) => [l, syntax] as const)),
)

// Linguist lists multiple languages for the same extension; there's no
// disambiguation metadata exposed, so pin the common collisions by hand.
const EXTENSION_OVERRIDES: Partial<Record<string, LanguageName>> = {
  '.md': 'Markdown',
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
}

const EXTENSION_SYNTAX_OVERRIDES: Partial<Record<string, CommentSyntax>> = {
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

export function getCommentSyntax(file: string, firstLine: string): CommentSyntax {
  const base = basename(file).toLowerCase()
  const ext = extname(base)
  const syntaxOverride = EXTENSION_SYNTAX_OVERRIDES[ext]
  if (syntaxOverride) return syntaxOverride

  const lang = detectLanguage(file, firstLine)
  if (!lang) {
    const reason = ambiguousExtensions.has(ext)
      ? 'ambiguous file type'
      : 'unrecognized file type'
    throw new Error(`Can't determine comment syntax for ${file}: ${reason}`)
  }
  const syntax = COMMENT_SYNTAX.get(lang)
  if (!syntax) {
    throw new Error(
      `Can't determine comment syntax for ${file}: no entry for language "${lang}"`,
    )
  }
  return syntax
}
