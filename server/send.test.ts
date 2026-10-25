/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffArgs, ErrorResponse, SendRequest } from '../shared/types.ts'
import { TOKEN_HEADER } from '../shared/types.ts'
import { isolateVcsConfig } from './testUtil.ts'
import { buildPayload, renderPrompt, runSend } from './send.ts'
import type { SendPayload } from './send.ts'
import type * as DiffModule from './diff.ts'

// getDiff is mocked so the routes don't need a repo.
const getDiff = vi.hoisted(() => vi.fn())
vi.mock('./diff.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffModule>()),
  getDiff,
}))

// See main.test.ts: HOME must be isolated before main.ts loads.
const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')
const dir = await mkdtemp(join(tmpdir(), 'skepsis-send-'))

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

const jj: DiffArgs = {
  vcs: 'jj',
  args: ['-r', '@-'],
  commentsEnabled: false,
  files: [],
  endpoints: null,
}

const comment: SendRequest = {
  file: 'src/a.ts',
  side: 'additions',
  lines: [42, 45],
  code: [{ lines: [41, 46], text: 'const a = 1\nconst b = 2' }],
  blob: 'abc123',
  text: 'why two?',
}

const payload = (input: Partial<SendRequest> = {}): SendPayload =>
  buildPayload(jj, '/repo', { ...comment, ...input })

describe('renderPrompt', () => {
  it('names the file, the lines, the side and the diff, then the code and text', () => {
    expect(payload().prompt).toBe(
      'Review comment on src/a.ts, lines 42–45 (new side of `jj diff -r @-`), in lines 41–46:\n\n' +
        '```\nconst a = 1\nconst b = 2\n```\n\nwhy two?',
    )
  })

  it('says one line and the old side for a deletion', () => {
    const p = payload({
      side: 'deletions',
      lines: [7, 7],
      code: [{ lines: [7, 7], text: 'x' }],
    })
    expect(p.prompt).toMatch(
      /^Review comment on src\/a\.ts, line 7 \(old side of `jj diff -r @-`\), in line 7:/,
    )
  })

  it('fences code that has its own fences', () => {
    const p = payload({ code: [{ lines: [1, 1], text: 'say ```hi```' }] })
    expect(p.prompt).toContain('\n````\nsay ```hi```\n````\n')
  })

  it('shows each run of an excerpt with a gap between', () => {
    const p = payload({
      lines: [10, 50],
      code: [
        { lines: [8, 13], text: 'a' },
        { lines: [47, 52], text: 'b' },
      ],
    })
    expect(p.prompt).toBe(
      'Review comment on src/a.ts, lines 10–50 (new side of `jj diff -r @-`), in lines 8–13 and lines 47–52:\n\n' +
        '```\na\n```\n\n```\nb\n```\n\nwhy two?',
    )
  })

  it('handles a comment with no anchor', () => {
    const p = payload({ file: null, side: null, lines: null, code: null })
    expect(p.prompt).toBe('Review comment on `jj diff -r @-`:\n\nwhy two?')
  })

  it('is the same function the payload uses', () => {
    const { prompt, ...rest } = payload()
    expect(renderPrompt(rest)).toBe(prompt)
  })
})

describe('buildPayload', () => {
  it('carries the contract fields', () => {
    const { prompt: _, ...rest } = payload()
    expect(rest).toEqual({
      version: 1,
      root: '/repo',
      diff: { command: 'jj diff -r @-', toWorkingCopy: false },
      file: 'src/a.ts',
      side: 'additions',
      lines: [42, 45],
      code: [{ lines: [41, 46], text: 'const a = 1\nconst b = 2' }],
      blob: 'abc123',
      text: 'why two?',
    })
  })
})

describe('runSend', () => {
  const opts = { cwd: dir, env: { SKEPSIS_URL: 'http://localhost:1', SKEPSIS_ROOT: dir } }

  it('pipes the payload as JSON and reports stdout', async () => {
    const out = join(dir, 'stdin.json')
    const result = await runSend(`cat > ${out}; echo sent; echo more`, payload(), opts)
    expect(result).toEqual({ ok: true, output: 'sent\nmore' })
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(payload())
  })

  it('runs in cwd with SKEPSIS_URL and SKEPSIS_ROOT set', async () => {
    const result = await runSend('echo "$PWD $SKEPSIS_URL $SKEPSIS_ROOT"', payload(), opts)
    expect(result).toEqual({
      ok: true,
      output: `${await realpath(dir)} http://localhost:1 ${dir}`,
    })
  })

  it('reports stderr on a nonzero exit, or the status without any', async () => {
    expect(await runSend('echo nope >&2; exit 1', payload(), opts)).toEqual({
      ok: false,
      error: 'nope',
    })
    expect(await runSend('exit 3', payload(), opts)).toEqual({
      ok: false,
      error: '--send command exited with 3',
    })
  })

  it('kills a command that runs past the timeout, with what it started', async () => {
    const start = Date.now()
    const result = await runSend('sleep 30', payload(), { ...opts, timeoutMs: 200 })
    expect(result).toEqual({ ok: false, error: '--send command timed out after 0.2 s' })
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('caps output', async () => {
    const result = await runSend('head -c 100000 /dev/zero | tr "\\0" x', payload(), {
      ...opts,
      maxOutput: 1000,
    })
    expect(result.ok && result.output.length).toBe(1000)
  })

  it("doesn't mind a command that ignores stdin", async () => {
    expect(await runSend('true', payload(), opts)).toEqual({ ok: true, output: '' })
  })
})

const post = (
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${url}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...headers },
    body: JSON.stringify(body),
  })

describe('/api/send', () => {
  beforeEach(() => {
    getDiff.mockReset()
    getDiff.mockResolvedValue({
      patch: 'diff --git a/src/a.ts b/src/a.ts\nindex a1d0001..fe0002 100644\n',
      fileHashes: { 'src/a.ts': 'fe0002' },
    })
  })

  async function serve(send: string | null) {
    const { port, token, close } = await startServer({ diffSource: jj, cwd: dir, send })
    return { url: `http://localhost:${port}`, token, close }
  }

  it("doesn't exist without --send", async () => {
    const { url, token, close } = await serve(null)
    expect((await post(url, token, comment)).status).toBe(404)
    const diff = (await (
      await fetch(`${url}/api/diff`, { headers: { [TOKEN_HEADER]: token } })
    ).json()) as { send: boolean }
    expect(diff.send).toBe(false)
    close()
  })

  it("sends the page's blob, even once the file has changed", async () => {
    // The server's diff has moved on to fe0002, but the lines and excerpt
    // come from the version the page shows.
    const out = join(dir, 'route.json')
    const { url, token, close } = await serve(`cat > ${out}`)
    const res = await post(url, token, comment)
    expect(res.status).toBe(200)
    const sent = JSON.parse(await readFile(out, 'utf8')) as SendPayload
    expect(sent.blob).toBe('abc123')
    expect(sent.text).toBe('why two?')
    expect((await post(url, token, { ...comment, blob: 'not a blob' })).status).toBe(400)
    close()
  })

  it('reports a failed command as an error', async () => {
    const { url, token, close } = await serve('echo "no agent" >&2; exit 1')
    const res = await post(url, token, comment)
    expect(res.status).toBe(502)
    expect(((await res.json()) as ErrorResponse).error).toBe('no agent')
    close()
  })

  it('turns away other origins and hosts', async () => {
    const { url, token, close } = await serve('true')
    const { port } = new URL(url)
    expect(
      (await post(url, token, comment, { Origin: 'http://localhost:9999' })).status,
    ).toBe(403)
    // undici won't let a request set Host, so check that one through the gate
    // test; same-origin requests from the page pass.
    expect(
      (await post(url, token, comment, { Origin: `http://localhost:${port}` })).status,
    ).toBe(200)
    close()
  })

  it('runs sends one at a time, in order', async () => {
    const log = join(dir, 'order.log')
    // The first send is the slow one, so without the queue it would finish last.
    const { url, token, close } = await serve(
      `t=$(grep -o '"text":"[a-z]*"' | cut -d '"' -f 4); [ "$t" = one ] && sleep 0.3; echo "$t" >> ${log}`,
    )
    const first = post(url, token, { ...comment, text: 'one' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = post(url, token, { ...comment, text: 'two' })
    await Promise.all([first, second])
    expect(await readFile(log, 'utf8')).toBe('one\ntwo\n')
    close()
  })
})
