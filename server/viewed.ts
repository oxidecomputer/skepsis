import { join } from 'path'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'

type ViewedMap = Record<string, string>

const BASE_DIR = join(process.env['HOME'] ?? '~', '.local', 'share', 'local-review')

function repoDir(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(BASE_DIR, hash)
}

function viewedPath(cwd: string, sessionKey: string): string {
  return join(repoDir(cwd), `viewed-${sessionKey}.json`)
}

export async function loadViewed(cwd: string, sessionKey: string): Promise<ViewedMap> {
  try {
    const raw = await readFile(viewedPath(cwd, sessionKey), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function saveViewed(cwd: string, sessionKey: string, data: ViewedMap): Promise<void> {
  const dir = repoDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeFile(viewedPath(cwd, sessionKey), JSON.stringify(data, null, 2) + '\n')
}

export async function markViewed(
  cwd: string,
  sessionKey: string,
  file: string,
  hash: string,
): Promise<void> {
  const data = await loadViewed(cwd, sessionKey)
  data[file] = hash
  await saveViewed(cwd, sessionKey, data)
}

export async function unmarkViewed(
  cwd: string,
  sessionKey: string,
  file: string,
): Promise<void> {
  const data = await loadViewed(cwd, sessionKey)
  delete data[file]
  await saveViewed(cwd, sessionKey, data)
}
