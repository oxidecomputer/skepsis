import { spawn } from 'child_process'
import { resolve } from 'path'
import { Command } from '@commander-js/extra-typings'

const program = new Command()
  .name('local-review')
  .description('Local diff review UI for jj')
  .argument('[revset]', 'revset to review', '@')
  .option('-r, --revision <revset>', 'revset to review (alternative to positional)')
  .option('-C, --directory <path>', 'run as if started in this directory')
  .option('--dev', 'run with Vite dev server for tool development')
  .parse()

const opts = program.opts()
const revset = opts.revision ?? program.args[0] ?? '@'
const cwd = opts.directory ? resolve(opts.directory) : process.cwd()

const projectRoot = import.meta.dirname
const apiPort = 3742

// Start API server
const api = spawn('bun', ['run', resolve(projectRoot, 'server/main.ts'), revset], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(apiPort) },
})

if (opts.dev) {
  const vitePort = 5173

  const vite = spawn('bunx', ['vite', '--port', String(vitePort), '--open'], {
    cwd: projectRoot,
    stdio: 'inherit',
  })

  function cleanup() {
    api.kill()
    vite.kill()
    process.exit()
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
} else {
  // Production mode: build frontend, API server serves dist/
  const build = spawn('bunx', ['vite', 'build'], {
    cwd: projectRoot,
    stdio: 'ignore',
  })

  build.on('exit', (code) => {
    if (code !== 0) {
      console.error('vite build failed')
      api.kill()
      process.exit(1)
    }
    spawn('open', [`http://localhost:${apiPort}`])
  })

  function cleanup() {
    build.kill()
    api.kill()
    process.exit()
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
