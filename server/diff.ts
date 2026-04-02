import { $ } from 'bun'
import { createHash } from 'crypto'
import type { FileHashes } from '../shared/types.ts'

export async function getDiff(
  revset: string,
): Promise<{ patch: string; fileHashes: FileHashes }> {
  const result = await $`jj diff -r ${revset} --git`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`jj diff failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
  }
  const patch = result.stdout.toString()
  return { patch, fileHashes: extractFileHashes(patch) }
}

/** Resolve a revset to a stable session key by hashing its change IDs. */
export async function resolveSessionKey(revset: string): Promise<string> {
  const result = await $`jj log -r ${revset} --no-graph -T 'change_id ++ "\n"'`
    .quiet()
    .nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`jj log failed: ${result.stderr.toString()}`)
  }
  const ids = result.stdout.toString().trim().split('\n').filter(Boolean).sort()
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
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
