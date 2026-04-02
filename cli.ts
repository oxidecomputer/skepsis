import { createServer } from 'net'
import { spawn } from 'child_process'
import { resolve } from 'path'
import { Command } from '@commander-js/extra-typings'

const program = new Command()
  .name('skepsis')
  .description('Local diff review UI for jj')
  .option('-r, --revisions <revsets>', 'show changes in these revisions')
  .option('-f, --from <revset>', 'show changes from this revision')
  .option('-t, --to <revset>', 'show changes to this revision')
  .option('-C, --directory <path>', 'run as if started in this directory')
  .option('--dev', 'run with Vite dev server for tool development')
  .parse()

const opts = program.opts()

// Build jj diff args matching jj's own -r/-f/-t flags
const diffArgs: string[] = []
if (opts.from || opts.to) {
  if (opts.from) diffArgs.push('--from', opts.from)
  if (opts.to) diffArgs.push('--to', opts.to)
} else {
  diffArgs.push('-r', opts.revisions ?? 'trunk()..@')
}

const cwd = opts.directory ? resolve(opts.directory) : process.cwd()

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr && typeof addr !== 'string') {
        srv.close(() => resolve(addr.port))
      } else {
        reject(new Error('failed to get free port'))
      }
    })
    srv.on('error', reject)
  })
}

const projectRoot = import.meta.dirname
const apiPort = await getFreePort()
const children: ReturnType<typeof spawn>[] = []

function cleanup(code = 0) {
  for (const child of children) child.kill()
  process.exit(code)
}

process.on('SIGINT', () => cleanup())
process.on('SIGTERM', () => cleanup())

// Start API server
const api = spawn('bun', ['run', resolve(projectRoot, 'server/main.ts'), ...diffArgs], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(apiPort) },
})
children.push(api)

api.on('exit', (code) => {
  if (code !== 0) cleanup(code ?? 1)
})

if (opts.dev) {
  const vite = spawn('bunx', ['vite', '--open'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: String(apiPort) },
  })
  children.push(vite)
} else {
  // Production mode: build frontend, API server serves dist/
  const build = spawn('bunx', ['vite', 'build'], {
    cwd: projectRoot,
    stdio: 'ignore',
  })
  children.push(build)

  build.on('exit', (code) => {
    if (code !== 0) {
      console.error('vite build failed')
      cleanup(1)
    }
    spawn('open', [`http://localhost:${apiPort}`])
  })
}
