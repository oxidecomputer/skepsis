import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

const REVIEW_MARKER = 'REVIEW:'

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
  const commentLine = suffix
    ? `${indent}${prefix} ${REVIEW_MARKER} ${text} ${suffix}`
    : `${indent}${prefix} ${REVIEW_MARKER} ${text}`

  lines.splice(afterLine, 0, commentLine)
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

  if (!lines[line - 1]!.includes(REVIEW_MARKER)) {
    throw new Error(`Line ${line} is not a REVIEW comment`)
  }

  lines.splice(line - 1, 1)
  await writeFile(filePath, lines.join('\n'))
}
