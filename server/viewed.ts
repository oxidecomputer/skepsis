import { join } from 'path'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'

type ViewedMap = Record<string, string>

const BASE_DIR = join(process.env['HOME'] ?? '~', '.local', 'share', 'local-review')

function repoDir(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(BASE_DIR, hash)
}

function viewedPath(cwd: string): string {
  return join(repoDir(cwd), 'viewed.json')
}

export async function loadViewed(cwd: string): Promise<ViewedMap> {
  try {
    const raw = await readFile(viewedPath(cwd), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function saveViewed(cwd: string, data: ViewedMap): Promise<void> {
  const dir = repoDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeFile(viewedPath(cwd), JSON.stringify(data, null, 2) + '\n')
}

export async function markViewed(cwd: string, file: string, hash: string): Promise<void> {
  const data = await loadViewed(cwd)
  data[file] = hash
  await saveViewed(cwd, data)
}

export async function unmarkViewed(cwd: string, file: string): Promise<void> {
  const data = await loadViewed(cwd)
  delete data[file]
  await saveViewed(cwd, data)
}
