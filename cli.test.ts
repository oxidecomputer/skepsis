/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TOKEN_HEADER, type DiffResponse } from './shared/types.ts'
import { exec, isolateVcsConfig, requireJj, run, startCli } from './server/testUtil.ts'

const CLI = join(import.meta.dirname, 'cli.ts')

/** Run the CLI to completion, for arguments it rejects before starting. */
async function runCli(args: string[], cwd: string) {
  const result = await exec('node', [CLI, '--no-open', ...args], { cwd }).catch(
    (error: { code: number; stderr: string }) => error,
  )
  return { code: 'code' in result ? result.code : 0, stderr: result.stderr }
}

const home = await isolateVcsConfig()
let tmp: string
let repo: string
let oldCommit: string
let newCommit: string

beforeAll(async () => {
  await requireJj()
  tmp = await mkdtemp(join(tmpdir(), 'skepsis-cli-test-'))
  await run('jj', ['git', 'init', 'repo'], tmp)
  repo = join(tmp, 'repo')
  const commitId = async (rev: string) =>
    (await run('jj', ['log', '-r', rev, '--no-graph', '-T', 'commit_id'], repo)).stdout
  // base → feature, then rebase feature onto an upstream commit and change
  // both its description and its content.
  await writeFile(join(repo, 'f.txt'), 'a\nb\nc\n')
  await writeFile(join(repo, 'up.txt'), 'x\n')
  await run('jj', ['commit', '-m', 'base'], repo)
  await writeFile(join(repo, 'f.txt'), 'a\nB\nc\n')
  await run('jj', ['describe', '-m', 'feature'], repo)
  oldCommit = await commitId('@')
  await run('jj', ['new', '@-', '-m', 'upstream'], repo)
  await writeFile(join(repo, 'up.txt'), 'x\ny\n')
  await run('jj', ['rebase', '-r', oldCommit, '-d', '@'], repo)
  await run('jj', ['edit', `children(@)`], repo)
  await run('jj', ['describe', '-m', 'feature, reworded'], repo)
  await writeFile(join(repo, 'f.txt'), 'a\nB\nc\nd\n')
  newCommit = await commitId('@')
})

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

/** Start the CLI with `args` and fetch its /api/diff. */
async function fetchDiff(args: string[], env?: NodeJS.ProcessEnv): Promise<DiffResponse> {
  const { proc, url } = await startCli(repo, ['--no-poll', ...args], env)
  try {
    const token = new URL(url).hash.replace('#token=', '')
    const res = await fetch(new URL('/api/diff', url), {
      headers: { [TOKEN_HEADER]: token },
    })
    return (await res.json()) as DiffResponse
  } finally {
    proc.kill()
  }
}

describe('--tab-size', () => {
  it('rejects anything but a width in columns', async () => {
    const results = await Promise.all(
      ['wide', '0', '17', '2.5'].map((value) => runCli(['--tab-size', value], repo)),
    )
    for (const { code, stderr } of results) {
      expect(code).toBe(1)
      expect(stderr).toContain('tab size must be an integer between 1 and 16')
    }
  })

  it('takes the flag over SKEPSIS_TAB_SIZE over the default', async () => {
    const set = { ...process.env, SKEPSIS_TAB_SIZE: '4' }
    expect((await fetchDiff(['-r', '@'])).tabSize).toBe(2)
    const empty = { ...process.env, SKEPSIS_TAB_SIZE: '' }
    expect((await fetchDiff(['-r', '@'], empty)).tabSize).toBe(2)
    expect((await fetchDiff(['-r', '@'], set)).tabSize).toBe(4)
    expect((await fetchDiff(['-r', '@', '--tab-size', '8'], set)).tabSize).toBe(8)
  })

  it('rejects a bad SKEPSIS_TAB_SIZE', async () => {
    const env = { ...process.env, SKEPSIS_TAB_SIZE: 'wide' }
    await expect(startCli(repo, ['-r', '@'], env)).rejects.toThrow(
      'tab size must be an integer between 1 and 16',
    )
  })
})

describe('--interdiff', () => {
  it('needs jj', async () => {
    const { code, stderr } = await runCli(
      ['--git', '--interdiff', '-f', 'a', '-t', 'b'],
      repo,
    )
    expect(code).toBe(1)
    expect(stderr).toContain('--interdiff needs jj')
  })

  it("can't be combined with -r", async () => {
    const { code, stderr } = await runCli(['--interdiff', '-r', '@'], repo)
    expect(code).toBe(1)
    expect(stderr).toContain("--interdiff can't be combined with -r")
  })

  it('needs -f or -t', async () => {
    const { code, stderr } = await runCli(['--interdiff'], repo)
    expect(code).toBe(1)
    expect(stderr).toContain('--interdiff needs -f, -t, or both')
  })

  it("serves the change's interdiff without upstream changes", async () => {
    const data = await fetchDiff(['--interdiff', '-f', oldCommit, '-t', newCommit])
    expect(data.revset).toBe(`jj interdiff --from ${oldCommit} --to ${newCommit}`)
    expect(Object.keys(data.fileHashes).toSorted()).toEqual([
      'JJ-COMMIT-DESCRIPTION',
      'f.txt',
    ])
    expect(data.patch).toContain('+feature, reworded')
    expect(data.patch).toContain('+d')
    expect(data.patch).not.toContain('up.txt')
    expect(data.interdiff).toBe(true)
    expect(data.expandable).toBe(false)
  })

  // -t defaults to @, which is newCommit: the diff ends at the working copy,
  // but comments stay off.
  it('keeps comments off when the interdiff ends at the working copy', async () => {
    const data = await fetchDiff(['--interdiff', '-f', oldCommit])
    expect(data.revset).toBe(`jj interdiff --from ${oldCommit}`)
    expect(Object.keys(data.fileHashes).toSorted()).toEqual([
      'JJ-COMMIT-DESCRIPTION',
      'f.txt',
    ])
    expect(data.commentsEnabled).toBe(false)
  })
})
