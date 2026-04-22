import { spawn } from 'node:child_process'
import type { DiffArgs, FileHashes } from '../shared/types.ts'

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

function diffCommand(src: DiffArgs): { cmd: string; args: string[] } {
  const fileArgs = src.files.length > 0 ? ['--', ...src.files] : []
  if (src.vcs === 'jj') {
    return { cmd: 'jj', args: ['diff', ...src.args, '--git', ...fileArgs] }
  } else {
    return { cmd: 'git', args: ['diff', ...src.args, ...fileArgs] }
  }
}

export async function getDiff(
  src: DiffArgs,
): Promise<{ patch: string; fileHashes: FileHashes }> {
  const { cmd, args } = diffCommand(src)
  const { stdout, stderr, code } = await run(cmd, args)
  if (code !== 0) {
    throw new Error(`${cmd} diff failed (exit ${code}): ${stderr}`)
  }
  return { patch: stdout, fileHashes: extractFileHashes(stdout) }
}

/** Validate diff args at startup. */
export async function validateDiffArgs(src: DiffArgs): Promise<void> {
  const { cmd } = diffCommand(src)
  const fileArgs = src.files.length > 0 ? ['--', ...src.files] : []
  const statArgs =
    src.vcs === 'jj'
      ? ['diff', ...src.args, '--stat', ...fileArgs]
      : ['diff', '--stat', ...src.args, ...fileArgs]
  const { stderr, code } = await run(cmd, statArgs)
  if (code !== 0) {
    throw new Error(`${cmd} diff failed: ${stderr}`)
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
