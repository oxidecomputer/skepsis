/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// --send: pipe a review comment to a user-supplied shell command. The JSON on
// the command's stdin is a public contract (see the README): fields can be
// added, but removing or changing one is a major version.

import { spawn } from 'node:child_process'
import type { DiffArgs, SendRequest } from '../shared/types.ts'
import { displayCommand } from './displayCommand.ts'

export interface SendPayload {
  version: 1
  /** The directory skepsis runs in, which is also the command's cwd */
  root: string
  diff: {
    /** The diff command, as the page shows it */
    command: string
    /** Whether the diff ends at the working copy */
    toWorkingCopy: boolean
  }
  file: string | null
  side: 'additions' | 'deletions' | null
  /** 1-based and inclusive, in `side`'s numbering */
  lines: [number, number] | null
  /** An excerpt of `side`: the lines commented on and a little around them,
   *  as runs of consecutive lines, each from line `lines[0]` to `lines[1]`.
   *  More than one where the diff hid lines in between. */
  code: { lines: [number, number]; text: string }[] | null
  /** The blob ID of `side`'s version of the file as the page showed it, the
   *  version `lines` number. Null where the diff has none, such as an added
   *  file's old side or a pure rename. */
  blob: string | null
  text: string
  /** All of the above as plain text, for consumers that just want a message */
  prompt: string
}

export function buildPayload(
  diffSource: DiffArgs,
  root: string,
  input: SendRequest,
): SendPayload {
  const base = {
    version: 1 as const,
    root,
    diff: {
      command: displayCommand(diffSource),
      toWorkingCopy: diffSource.commentsEnabled,
    },
    file: input.file,
    side: input.side,
    lines: input.lines,
    code: input.code,
    blob: input.blob,
    text: input.text,
  }
  return { ...base, prompt: renderPrompt(base) }
}

/** A fence one backtick longer than any run of backticks in `code`. */
function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

export function renderPrompt(p: Omit<SendPayload, 'prompt'>): string {
  const command = `\`${p.diff.command}\``
  if (p.file === null) return `Review comment on ${command}:\n\n${p.text}`
  const where = !p.lines
    ? ''
    : p.lines[0] === p.lines[1]
      ? `, line ${p.lines[0]}`
      : `, lines ${p.lines[0]}–${p.lines[1]}`
  const side = p.side === 'deletions' ? 'old side' : 'new side'
  const head = `Review comment on ${p.file}${where} (${side} of ${command})`
  if (!p.code) return `${head}:\n\n${p.text}`
  const ranges = p.code.map(({ lines: [first, last] }) =>
    first === last ? `line ${first}` : `lines ${first}–${last}`,
  )
  const excerpts = p.code.map(({ text }) => {
    const f = fence(text)
    return `${f}\n${text}\n${f}`
  })
  return `${head}, in ${ranges.join(' and ')}:\n\n${excerpts.join('\n\n')}\n\n${p.text}`
}

export type SendResult = { ok: true; output: string } | { ok: false; error: string }

export interface RunOptions {
  /** Added to skepsis's own environment */
  env: Record<string, string>
  cwd: string
  timeoutMs?: number
  /** Per stream, in bytes */
  maxOutput?: number
}

const TIMEOUT_MS = 10_000
const MAX_OUTPUT = 64 * 1024

/** Run `sh -c command` with the payload as JSON on stdin. Exit 0 is success;
 *  anything else, or running past the timeout, is an error. */
export function runSend(
  command: string,
  payload: SendPayload,
  { env, cwd, timeoutMs = TIMEOUT_MS, maxOutput = MAX_OUTPUT }: RunOptions,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the timeout kills what it started too
      // (`sleep` under `sh -c`, the far end of a pipe).
      detached: true,
    })
    const collect = (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        if (size >= maxOutput) return
        chunks.push(chunk.subarray(0, maxOutput - size))
        size += chunk.length
      })
      return () => Buffer.concat(chunks).toString('utf8').trim()
    }
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({
          ok: false,
          error: `--send command timed out after ${timeoutMs / 1000} s`,
        })
      } else if (code === 0) {
        resolve({ ok: true, output: stdout() })
      } else {
        const status = signal ? `was killed (${signal})` : `exited with ${code}`
        resolve({ ok: false, error: stderr() || `--send command ${status}` })
      }
    })
    // A command that never reads stdin (`true`) closes the pipe early; that's
    // its business, not an error.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload) + '\n')
  })
}
