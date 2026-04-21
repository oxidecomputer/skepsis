import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

const OPEN_TAG = '<review>'
const CLOSE_TAG = '</review>'

function getCommentSyntax(filePath: string): { prefix: string; suffix: string } {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'py':
    case 'rb':
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'conf':
      return { prefix: '#', suffix: '' }
    case 'html':
    case 'xml':
    case 'svg':
      return { prefix: '<!--', suffix: '-->' }
    case 'css':
    case 'scss':
    case 'less':
      return { prefix: '/*', suffix: '*/' }
    case 'sql':
    case 'lua':
    case 'hs':
      return { prefix: '--', suffix: '' }
    default:
      return { prefix: '//', suffix: '' }
  }
}

function openTagRegex(prefix: string): RegExp {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${esc}\\s*${OPEN_TAG}\\s*(?:\\*\\/|-->)?\\s*$`)
}

function closeTagRegex(prefix: string): RegExp {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${esc}\\s*${CLOSE_TAG}\\s*(?:\\*\\/|-->)?\\s*$`)
}

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
  const { prefix, suffix } = getCommentSyntax(file)
  const wrap = (body: string) => {
    if (!body) return suffix ? `${indent}${prefix} ${suffix}` : `${indent}${prefix}`
    return suffix ? `${indent}${prefix} ${body} ${suffix}` : `${indent}${prefix} ${body}`
  }

  const commentLines = [
    wrap(OPEN_TAG),
    ...text.split('\n').map((line) => wrap(line)),
    wrap(CLOSE_TAG),
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

  const { prefix } = getCommentSyntax(file)
  const openRe = openTagRegex(prefix)
  const closeRe = closeTagRegex(prefix)

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
