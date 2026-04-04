import { spawn } from 'child_process'
import { Command } from '@commander-js/extra-typings'
import { startServer } from './server/main.ts'

const program = new Command()
  .name('skepsis')
  .description('Local diff review UI for jj')
  .option('-r, --revisions <revsets>', 'show changes in these revisions')
  .option('-f, --from <revset>', 'show changes from this revision')
  .option('-t, --to <revset>', 'show changes to this revision')
  .option('--dev', 'run with Vite dev server for tool development')
  .parse()

const opts = program.opts()

// Build jj diff args matching jj's own -r/-f/-t flags
const diffArgs: string[] = []
let commentsEnabled: boolean
if (opts.from || opts.to) {
  if (opts.from) diffArgs.push('--from', opts.from)
  if (opts.to) diffArgs.push('--to', opts.to)
  // Comments enabled if --to is @ or omitted (jj defaults --to to @)
  commentsEnabled = !opts.to || opts.to === '@'
} else {
  const rev = opts.revisions ?? 'trunk()..@'
  diffArgs.push('-r', rev)
  // Comments enabled if revset ends with ..@
  commentsEnabled = rev.endsWith('..@')
}

const cwd = process.cwd()
const projectRoot = import.meta.dirname
const children: ReturnType<typeof spawn>[] = []

function cleanup(code = 0) {
  for (const child of children) child.kill()
  process.exit(code)
}

process.on('SIGINT', () => cleanup())
process.on('SIGTERM', () => cleanup())

const apiPort = await startServer({ diffArgs, commentsEnabled, cwd })

if (opts.dev) {
  const vite = spawn('npx', ['vite', '--open'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: String(apiPort) },
  })
  children.push(vite)
} else {
  spawn('open', [`http://localhost:${apiPort}`])
}
