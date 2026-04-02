import { $ } from 'bun'
import { createHash } from 'crypto'
import type { FileHashes } from '../shared/types.ts'

export async function getDiff(
  diffArgs: string[],
): Promise<{ patch: string; fileHashes: FileHashes }> {
  const result = await $`jj diff ${diffArgs} --git`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`jj diff failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
  }
  const patch = result.stdout.toString()
  return { patch, fileHashes: extractFileHashes(patch) }
}

/** Resolve diff args to a stable session key. Validates the args against jj. */
export async function resolveSessionKey(diffArgs: string[]): Promise<string> {
  // Run jj diff --stat as a cheap validation that the args are valid
  const result = await $`jj diff ${diffArgs} --stat`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`jj diff failed: ${result.stderr.toString()}`)
  }
  return createHash('sha256').update(diffArgs.join('\0')).digest('hex').slice(0, 16)
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
