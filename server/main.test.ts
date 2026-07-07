/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiffArgs, DiffResponse, FileContentsResponse } from '../shared/types.ts'
import { exec, isolateVcsConfig, requireJj } from './testUtil.ts'

// HOME is also where viewed state is stored, and it's read at module load —
// so isolation must run before main.ts is imported, hence the dynamic import.
const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

/**
 * Boot the real server against a real temp repo and exercise the API over
 * HTTP: the diff itself, the viewed round trip (including content-addressed
 * auto-unview), comment insert/remove into working-copy files, and full file
 * contents at the diff endpoints.
 */
describe.each(['git', 'jj'] as const)('startServer (%s integration)', (vcs) => {
  let dir: string
  let origCwd: string
  let close: (() => void) | undefined
  let url: string

  const run = (cmd: string, args: string[]) => exec(cmd, args, { cwd: dir })

  beforeAll(async () => {
    if (vcs === 'jj') await requireJj()
    dir = await mkdtemp(join(tmpdir(), `skepsis-server-test-${vcs}-`))
    await run(vcs, vcs === 'git' ? ['init', '-q'] : ['git', 'init'])
    await writeFile(join(dir, 'f.txt'), 'hello\n')
    await writeFile(join(dir, 'g.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(dir, 'del.txt'), 'bye\n')
    await writeFile(join(dir, 'r.txt'), 'rename me\n')
    await writeFile(join(dir, 'c.ts'), 'const one = 1\n')
    if (vcs === 'git') {
      await run('git', ['add', '.'])
      await run('git', ['commit', '-qm', 'init'])
    } else {
      await run('jj', ['commit', '-m', 'init'])
    }
    await writeFile(join(dir, 'f.txt'), 'hello\nworld\n')
    await appendFile(join(dir, 'g.txt'), 'four\n')
    await writeFile(join(dir, 'added.txt'), 'new\n')
    await rm(join(dir, 'del.txt'))
    await rename(join(dir, 'r.txt'), join(dir, 'r2.txt'))
    await appendFile(join(dir, 'r2.txt'), 'plus\n')
    await appendFile(join(dir, 'c.ts'), 'const two = 2\n')

    // getDiff and file-contents spawn git/jj in the process cwd (the CLI
    // always starts the server from inside the target repo), so chdir in.
    origCwd = process.cwd()
    process.chdir(dir)

    const base = { commentsEnabled: true, files: [] }
    const diffSource: DiffArgs =
      vcs === 'git'
        ? {
            vcs,
            args: ['HEAD'],
            ...base,
            endpoints: { left: 'HEAD', right: 'workingCopy' },
          }
        : {
            vcs,
            args: ['-r', '@'],
            ...base,
            endpoints: { left: '@-', right: { rev: '@' } },
          }
    const started = await startServer({ diffSource, cwd: dir })
    close = started.close
    url = `http://localhost:${started.port}`
  })

  afterAll(async () => {
    close?.()
    if (origCwd) process.chdir(origCwd)
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function getDiffResponse(): Promise<DiffResponse> {
    const res = await fetch(`${url}/api/diff`)
    expect(res.status).toBe(200)
    return res.json()
  }

  async function api(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('serves the diff with content-addressed file hashes', async () => {
    const diff = await getDiffResponse()
    expect(diff.vcs).toBe(vcs)
    expect(diff.commentsEnabled).toBe(true)
    expect(diff.expandable).toBe(true)
    expect(diff.patch).toContain('diff --git a/f.txt b/f.txt')
    expect(diff.patch).toContain('+world')
    // The per-file hash is the (abbreviated) git blob ID of the new contents —
    // the invariant the viewed state's content addressing depends on.
    // hash-object needs no repo, so it works the same in the jj case.
    const { stdout } = await run('git', ['hash-object', 'f.txt'])
    expect(stdout.trim()).toMatch(new RegExp(`^${diff.fileHashes['f.txt']}`))
  })

  it('round-trips viewed state and auto-unviews when content changes', async () => {
    let diff = await getDiffResponse()
    expect(diff.viewed).toEqual({})
    const hash = diff.fileHashes['f.txt']!

    const res = await api('POST', '/api/viewed', { file: 'f.txt', hash })
    expect(await res.json()).toEqual({ ok: true })
    diff = await getDiffResponse()
    expect(diff.viewed['f.txt']).toBe(hash)

    // Changing the file changes its blob ID, so it comes back unviewed with
    // no explicit invalidation.
    await appendFile(join(dir, 'f.txt'), 'more\n')
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({})
  })

  it('unmarks viewed state individually and in bulk', async () => {
    let diff = await getDiffResponse()
    const fHash = diff.fileHashes['f.txt']!
    const gHash = diff.fileHashes['g.txt']!
    await api('POST', '/api/viewed', { file: 'f.txt', hash: fHash })
    await api('POST', '/api/viewed', { file: 'g.txt', hash: gHash })
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({ 'f.txt': fHash, 'g.txt': gHash })

    let res = await api('DELETE', '/api/viewed', { file: 'f.txt', hash: fHash })
    expect(await res.json()).toEqual({ ok: true })
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({ 'g.txt': gHash })

    res = await api('DELETE', '/api/viewed-all', {
      files: [{ file: 'g.txt', hash: gHash }],
    })
    expect(await res.json()).toEqual({ ok: true })
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({})
  })

  it('inserts and removes review comments in the working copy', async () => {
    const before = await readFile(join(dir, 'g.txt'), 'utf-8')

    let res = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 2,
      text: 'needs work',
    })
    expect(await res.json()).toEqual({ ok: true })
    // The comment exists as real lines on disk, which is why it shows up in
    // the diff at all.
    const withComment = await readFile(join(dir, 'g.txt'), 'utf-8')
    expect(withComment).toBe('one\ntwo\n<review>\nneeds work\n</review>\nthree\nfour\n')
    const diff = await getDiffResponse()
    expect(diff.patch).toContain('+<review>')
    expect(diff.patch).toContain('+needs work')

    // Remove by the open tag's line number and the file is back to normal
    res = await api('DELETE', '/api/comment', { file: 'g.txt', line: 3 })
    expect(await res.json()).toEqual({ ok: true })
    expect(await readFile(join(dir, 'g.txt'), 'utf-8')).toBe(before)
  })

  it("wraps review comments in the file's comment syntax", async () => {
    const diff = await getDiffResponse()
    expect(diff.commentSyntaxes['c.ts']).toEqual({ prefix: '//' })

    let res = await api('POST', '/api/comment', {
      file: 'c.ts',
      afterLine: 1,
      text: 'why one?',
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(await readFile(join(dir, 'c.ts'), 'utf-8')).toBe(
      'const one = 1\n// <review>\n// why one?\n// </review>\nconst two = 2\n',
    )

    res = await api('DELETE', '/api/comment', { file: 'c.ts', line: 2 })
    expect(await res.json()).toEqual({ ok: true })
    expect(await readFile(join(dir, 'c.ts'), 'utf-8')).toBe(
      'const one = 1\nconst two = 2\n',
    )
  })

  it('serves full file contents at both diff endpoints', async () => {
    const res = await fetch(`${url}/api/file-contents?path=f.txt`)
    expect(res.status).toBe(200)
    const contents: FileContentsResponse = await res.json()
    expect(contents.oldContents).toBe('hello\n')
    expect(contents.newContents).toBe(await readFile(join(dir, 'f.txt'), 'utf-8'))
  })

  it('returns null for the missing side of added and deleted files', async () => {
    let res = await fetch(`${url}/api/file-contents?path=added.txt`)
    expect((await res.json()) as FileContentsResponse).toEqual({
      oldContents: null,
      newContents: 'new\n',
    })
    res = await fetch(`${url}/api/file-contents?path=del.txt`)
    expect((await res.json()) as FileContentsResponse).toEqual({
      oldContents: 'bye\n',
      newContents: null,
    })
  })

  it('serves old contents via oldPath for renamed files', async () => {
    const res = await fetch(`${url}/api/file-contents?path=r2.txt&oldPath=r.txt`)
    expect(res.status).toBe(200)
    expect((await res.json()) as FileContentsResponse).toEqual({
      oldContents: 'rename me\n',
      newContents: 'rename me\nplus\n',
    })
  })

  it('rejects malformed requests', async () => {
    const res = await api('POST', '/api/viewed', { file: 'f.txt' }) // missing hash
    expect(res.status).toBe(400)
  })

  // Bad diff args should fail startServer itself, before the first /api/diff.
  it('startServer rejects when the diff command fails', async () => {
    const badSource: DiffArgs =
      vcs === 'git'
        ? { vcs, args: ['not-a-ref'], commentsEnabled: true, files: [], endpoints: null }
        : {
            vcs,
            args: ['-r', 'no_such_rev'],
            commentsEnabled: true,
            files: [],
            endpoints: null,
          }
    await expect(startServer({ diffSource: badSource, cwd: dir })).rejects.toThrow(
      /diff failed/,
    )
  })
})
