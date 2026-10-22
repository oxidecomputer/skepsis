/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// Compare two token dumps written by diff.visual.ts's "token dump" test:
//
//   node e2e/visual/compareTokens.ts .visual/tokens-a.json .visual/tokens-b.json [n]
//
// Screenshots of two highlighters differ on every token, which hides what
// matters. This reports, per file and theme, the share of visible characters
// whose styling changed, then the first n (default 6) changed lines with each
// changed stretch of text and its style before and after.

import { readFileSync } from 'node:fs'

type Runs = [text: string, style: string][]
type Dump = Record<string, Record<string, Runs>>
type Theme = 'light' | 'dark'
const THEMES: Theme[] = ['light', 'dark']

const [aPath, bPath, limitArg] = process.argv.slice(2)
if (!aPath || !bPath) {
  console.error('usage: compareTokens.ts <a.json> <b.json> [lines per file]')
  process.exit(2)
}
const limit = Number(limitArg ?? 6)
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Dump
const a = load(aPath)
const b = load(bPath)

const WEIGHTS: Record<string, string> = { '700': 'bold', '400': 'normal' }

/** One theme's styling from a token's style attribute, in a form that's equal
 *  across highlighters when it renders the same: `#1f2328 font-weight=bold`.
 *  Shiki and Highlights order the properties differently, case hex colors
 *  differently and spell weights differently. */
function themeStyle(style: string, theme: Theme): string {
  const prefix = `--diffs-token-${theme}`
  let color = '-'
  const rest: string[] = []
  for (const decl of style.split(';')) {
    const [key, value] = decl.split(':').map((s) => s.trim()) as [string, string?]
    if (!key.startsWith(prefix) || value === undefined) continue
    if (key === prefix) color = value.toLowerCase()
    else {
      const prop = key.slice(prefix.length + 1)
      rest.push(`${prop}=${prop === 'font-weight' ? (WEIGHTS[value] ?? value) : value}`)
    }
  }
  return [color, ...rest.toSorted()].join(' ')
}

const perChar = (runs: Runs, theme: Theme) =>
  runs.flatMap(([text, style]) => [...text].map(() => themeStyle(style, theme)))
const text = (runs: Runs) => runs.map(([t]) => t).join('')

/** Maximal stretches where the two per-character style lists disagree. */
function changedStretches(chars: string[], sa: string[], sb: string[]) {
  const out: string[] = []
  let i = 0
  while (i < chars.length) {
    if (sa[i] === sb[i] || chars[i]!.trim() === '') {
      i++
      continue
    }
    let j = i
    while (j < chars.length && sa[j] === sa[i] && sb[j] === sb[i]) j++
    out.push(`"${chars.slice(i, j).join('')}" ${sa[i]} → ${sb[i]}`)
    i = j
  }
  return out
}

const files = [...new Set([...Object.keys(a), ...Object.keys(b)])].toSorted()
const summary: string[] = []
const details: string[] = []
for (const file of files) {
  const la = a[file] ?? {}
  const lb = b[file] ?? {}
  const keys = [...new Set([...Object.keys(la), ...Object.keys(lb)])].toSorted(
    (x, y) => Number(x.split(':')[1]) - Number(y.split(':')[1]) || x.localeCompare(y),
  )
  let total = 0
  const changed = { light: 0, dark: 0 }
  const examples: string[] = []
  for (const key of keys) {
    const ra = la[key]
    const rb = lb[key]
    if (!ra || !rb) {
      examples.push(`  ${key}: only in ${ra ? 'a' : 'b'}`)
      continue
    }
    if (text(ra) !== text(rb)) {
      examples.push(`  ${key}: text differs`)
      continue
    }
    // Whitespace styling is invisible, so it doesn't count.
    const chars = [...text(ra)]
    total += chars.filter((c) => c.trim() !== '').length
    const lines: string[] = []
    for (const theme of THEMES) {
      const sa = perChar(ra, theme)
      const sb = perChar(rb, theme)
      changed[theme] += chars.filter((c, i) => c.trim() !== '' && sa[i] !== sb[i]).length
      for (const s of changedStretches(chars, sa, sb)) lines.push(`      ${theme}: ${s}`)
    }
    if (lines.length > 0 && examples.length < limit) {
      examples.push(`  ${key}: ${text(ra).trim()}`, ...lines)
    }
  }
  const pct = (n: number) => (total ? ((100 * n) / total).toFixed(1) : '0.0').padStart(5)
  summary.push(
    `light ${pct(changed.light)}%  dark ${pct(changed.dark)}%  ${file} (${total} chars)`,
  )
  if (examples.length) details.push(`${file}\n${examples.join('\n')}`)
}

console.info(summary.join('\n'))
if (details.length) console.info(`\n${details.join('\n\n')}`)
