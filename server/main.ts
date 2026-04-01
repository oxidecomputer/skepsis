import { getDiff, resolveSessionKey } from './diff.ts'
import { loadViewed, markViewed, unmarkViewed } from './viewed.ts'

const revset = process.argv[2] || '@'
const port = Number(process.env['PORT']) || 3742
const cwd = process.cwd()
const sessionKey = await resolveSessionKey(revset)

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/api/diff') {
      try {
        const { patch, fileHashes } = await getDiff(revset)
        const viewed = await loadViewed(cwd, sessionKey)
        return Response.json({ patch, revset, fileHashes, viewed })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return Response.json({ error: message }, { status: 500 })
      }
    }

    if (url.pathname === '/api/viewed' && req.method === 'POST') {
      const { file, hash } = await req.json()
      if (typeof file !== 'string' || typeof hash !== 'string') {
        return Response.json({ error: 'file and hash required' }, { status: 400 })
      }
      await markViewed(cwd, sessionKey, file, hash)
      return Response.json({ ok: true })
    }

    if (url.pathname === '/api/viewed' && req.method === 'DELETE') {
      const { file } = await req.json()
      if (typeof file !== 'string') {
        return Response.json({ error: 'file required' }, { status: 400 })
      }
      await unmarkViewed(cwd, sessionKey, file)
      return Response.json({ ok: true })
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`local-review API on http://localhost:${port} (revset: ${revset})`)
