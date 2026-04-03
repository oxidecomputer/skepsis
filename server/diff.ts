import { spawn } from 'node:child_process'
import type { FileHashes } from '../shared/types.ts'

function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', (d) => stderr.push(d))
    proc.on('error', reject)
    proc.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        code: code ?? 1,
      }),
    )
  })
}

export async function getDiff(
  diffArgs: string[],
): Promise<{ patch: string; fileHashes: FileHashes }> {
  const { stdout, stderr, code } = await run('jj', ['diff', ...diffArgs, '--git'])
  if (code !== 0) {
    throw new Error(`jj diff failed (exit ${code}): ${stderr}`)
  }
  return { patch: stdout, fileHashes: extractFileHashes(stdout) }
}

/** Validate diff args against jj at startup. */
export async function validateDiffArgs(diffArgs: string[]): Promise<void> {
  const { stderr, code } = await run('jj', ['diff', ...diffArgs, '--stat'])
  if (code !== 0) {
    throw new Error(`jj diff failed: ${stderr}`)
  }
}

/**
 * Extract newObjectId per file from the git diff's index lines.
 * Format: "diff --git a/<path> b/<path>" followed by "index <old>..<new> <mode>"
 */
function extractFileHashes(patch: string): FileHashes {
  const hashes: FileHashes = {}
  let currentFile: string | null = null

  for (const line of patch.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (diffMatch) {
      currentFile = diffMatch[1]!
      continue
    }
    if (currentFile && line.startsWith('index ')) {
      const indexMatch = line.match(/^index [0-9a-f]+\.\.([0-9a-f]+)/)
      if (indexMatch) {
        hashes[currentFile] = indexMatch[1]!
      }
      currentFile = null
    }
  }

  return hashes
}
