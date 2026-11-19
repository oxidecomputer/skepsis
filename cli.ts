#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command, InvalidArgumentError, Option } from '@commander-js/extra-typings'
import { startServer } from './server/main.ts'
import { LOOPBACK } from './server/gate.ts'
import { buildDiffSource, detectVcs } from './server/diffSource.ts'
import { DEFAULT_TAB_SIZE } from './shared/types.ts'
import type { DiffArgs } from './shared/types.ts'

function parsePort(value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN
  // 0 asks for a free port, the same as leaving the flag out
  if (!(port >= 0 && port <= 65535)) {
    throw new InvalidArgumentError('port must be an integer between 0 and 65535')
  }
  return port
}

function parseTabSize(value: string): number {
  const size = /^\d+$/.test(value) ? Number(value) : NaN
  // The top end is only there to catch typos
  if (!(size >= 1 && size <= 16)) {
    throw new InvalidArgumentError('tab size must be an integer between 1 and 16')
  }
  return size
}

// Each SKEPSIS_ variable stands in for a flag (see .env() below). An empty
// one counts as unset.
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('SKEPSIS_') && value === '') delete process.env[name]
}

const program = new Command()
  .name('skepsis')
  .description('Local diff review UI (auto-detects jj or git)')
  .option('-r, --revisions <revsets>', 'Show changes in these revisions')
  .option('-f, --from <rev>', 'Show changes from this revision')
  .option('-t, --to <rev>', 'Show changes to this revision')
  .option(
    '--interdiff',
    'Show how the change in --to differs from the change in --from (jj only)',
  )
  .option('--git', 'force git mode (skip jj detection)')
  .option('--dev', 'run with Vite dev server for development')
  .option('--host <address>', 'address to bind the HTTP server to', 'localhost')
  .option('-p, --port <number>', 'port for the browser UI (default: a free one)', parsePort)
  .option('--no-open', "don't open a browser")
  .addOption(
    new Option(
      '--open-cmd <command>',
      'shell command that opens the page, given the URL as its last argument',
    )
      .env('SKEPSIS_OPEN')
      .default('', 'the system opener'),
  )
  .option('--no-poll', "don't check for changes to the diff while the page is open")
  .addOption(
    new Option('--tab-size <columns>', 'tab width in columns')
      .env('SKEPSIS_TAB_SIZE')
      .argParser(parseTabSize)
      .default(DEFAULT_TAB_SIZE),
  )
  .addOption(
    new Option(
      '--send <command>',
      'add a Send button that pipes the comment to this shell command',
    ).env('SKEPSIS_SEND'),
  )
  .argument('[files...]', 'Limit diff to these paths (passed through to jj/git)')
  .addHelpText(
    'after',
    '\nOnce the server is listening, it prints one line to stdout,\n' +
      '`skepsis on <url> (<diff command>)`, for scripts that start it in the\n' +
      'background with --no-open. The URL ends in a per-run #token= the page\n' +
      'needs, so open it whole.\n\n' +
      'With --send, the comment box sends to `sh -c <command>`, run in this\n' +
      'directory, with the comment as one JSON object on stdin (its `prompt`\n' +
      'field has it all as plain text). Exit 0 means delivered; anything else,\n' +
      'or taking over 10 s, is an error, and stderr is shown.\n' +
      'See the README for the fields and recipes.',
  )
  .parse()

const opts = program.opts()

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const hostname = opts.host
// An empty --open-cmd means the system opener. An empty --send turns sending
// off.
const openCmd = opts.openCmd || null
const send = opts.send || null
if (send && !LOOPBACK.has(hostname === '::1' ? '[::1]' : hostname)) {
  fail(
    `--send runs a command on request from the page, so it needs a loopback\n` +
      `--host (localhost, 127.0.0.1 or ::1), not ${hostname}.`,
  )
}

let diffSource: DiffArgs
try {
  diffSource = buildDiffSource({
    vcs: opts.git ? 'git' : detectVcs(),
    revisions: opts.revisions,
    from: opts.from,
    to: opts.to,
    interdiff: opts.interdiff,
    files: program.processedArgs[0],
  })
} catch (err) {
  fail((err as Error).message)
}

const cwd = process.cwd()
const children: ReturnType<typeof spawn>[] = []

function findCheckoutRoot(): string | null {
  const sourceRoot = import.meta.dirname
  if (existsSync(join(sourceRoot, 'vite.config.ts'))) return sourceRoot

  const packageRoot = dirname(sourceRoot)
  if (existsSync(join(packageRoot, 'vite.config.ts'))) return packageRoot

  return null
}

function cleanup(code = 0): never {
  for (const child of children) child.kill()
  process.exit(code)
}

function requireCheckoutRoot(): string {
  const checkoutRoot = findCheckoutRoot()
  if (checkoutRoot === null) {
    console.error(
      '--dev only works from a skepsis source checkout, not the installed package.\n' +
        'Clone https://github.com/oxidecomputer/skepsis and run: node cli.ts --dev',
    )
    cleanup(1)
  }
  return checkoutRoot
}

process.on('SIGINT', () => cleanup())
process.on('SIGTERM', () => cleanup())

const checkoutRoot = opts.dev ? requireCheckoutRoot() : undefined
// In development Vite owns the browser-facing port and proxies API requests
// to this server, so leave the API on an ephemeral port. In the packaged app
// the API server also serves the UI and can bind the requested port directly.
const { port: apiPort, token } = await startServer({
  diffSource,
  cwd,
  hostname,
  port: opts.dev ? undefined : opts.port,
  poll: opts.poll,
  send,
  tabSize: opts.tabSize,
}).catch((err: Error) => {
  console.error(err.message)
  return cleanup(1)
})

function urlOpenCommand(url: string): { cmd: string; args: string[] } {
  // "$1" rather than splicing the URL into the command, so the shell never
  // parses it.
  if (openCmd) return { cmd: 'sh', args: ['-c', `${openCmd} "$1"`, 'sh', url] }
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] }
    case 'win32':
      return { cmd: 'cmd', args: ['/c', 'start', '', url] }
    default:
      return { cmd: 'xdg-open', args: [url] }
  }
}

// Only auto-open a browser when bound to localhost. With any other host,
// the user is likely on a remote dev box and the browser lives elsewhere
// — opening locally would just spawn an unwanted browser.
const shouldAutoOpen = opts.open && hostname === 'localhost'

if (opts.dev) {
  const viteArgs = ['vite', '--host', hostname]
  if (opts.port) viteArgs.push('--port', String(opts.port), '--strictPort')
  // Vite resolves a string --open against its own URL, fragment included.
  if (shouldAutoOpen) viteArgs.push('--open', `/#token=${token}`)
  const vite = spawn('npx', viteArgs, {
    cwd: checkoutRoot,
    stdio: 'inherit',
    env: { ...process.env, API_HOST: hostname, API_PORT: String(apiPort) },
  })
  children.push(vite)
} else if (shouldAutoOpen) {
  const url = `http://localhost:${apiPort}/#token=${token}`
  const { cmd, args } = urlOpenCommand(url)
  // A custom command's stderr shows, since a typo there is the user's to fix.
  const opener = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'ignore', openCmd ? 'inherit' : 'ignore'],
  })
  // The URL is already printed on server startup, so a failed system opener
  // (e.g. no xdg-open on illumos) needs no message — swallow the error and
  // carry on.
  opener.on('error', () => {})
  if (openCmd)
    opener.on('exit', (code) => {
      if (code) console.error(`The open command exited with status ${code}`)
    })
  opener.unref()
}
