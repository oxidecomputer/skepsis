import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import type { FileDiffMetadata } from '@pierre/diffs'

const queryClient = new QueryClient()

const wideQuery = '(min-width: 1200px)'

function useIsWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(wideQuery)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    () => window.matchMedia(wideQuery).matches,
  )
}

type ViewedMap = Record<string, string>
type FileHashes = Record<string, string>

interface DiffData {
  patch?: string
  revset: string
  error?: string
  fileHashes: FileHashes
  viewed: ViewedMap
}

function getFileStats(fileDiff: FileDiffMetadata) {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines
    deletions += hunk.deletionLines
  }
  return { additions, deletions }
}

function FileHeader({
  fileDiff,
  fileHashes,
  viewed,
}: {
  fileDiff: FileDiffMetadata
  fileHashes: FileHashes
  viewed: ViewedMap
}) {
  const qc = useQueryClient()
  const name = fileDiff.name
  const hash = fileHashes[name]
  const viewedHash = viewed[name]
  const isViewed = hash != null && viewedHash === hash
  const isStale = viewedHash != null && hash != null && viewedHash !== hash
  const { additions, deletions } = getFileStats(fileDiff)

  const markMutation = useMutation({
    mutationFn: (mark: boolean) =>
      mark
        ? fetch('/api/viewed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: name, hash }),
          })
        : fetch('/api/viewed', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: name }),
          }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['diff'] }),
  })

  const toggle = () => markMutation.mutate(!isViewed)

  return (
    <div className="file-header">
      <span className="file-header-name">{name}</span>
      <span className="file-header-stats">
        {additions > 0 && <span className="stat-add">+{additions}</span>}
        {deletions > 0 && <span className="stat-del">-{deletions}</span>}
      </span>
      <label className={'viewed-label' + (isStale ? ' stale' : '')} onClick={toggle}>
        {isStale ? 'Changed' : 'Viewed'}
      </label>
      <input
        type="checkbox"
        className={'viewed-checkbox' + (isStale ? ' stale' : '')}
        checked={isViewed}
        onChange={toggle}
      />
    </div>
  )
}

function ProgressBar({
  fileHashes,
  viewed,
}: {
  fileHashes: FileHashes
  viewed: ViewedMap
}) {
  const total = Object.keys(fileHashes).length
  const viewedCount = Object.entries(fileHashes).filter(
    ([file, hash]) => viewed[file] === hash,
  ).length

  if (total === 0) return null

  return (
    <div className="progress-bar">
      <span>
        {viewedCount}/{total} files viewed
      </span>
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${(viewedCount / total) * 100}%` }}
        />
      </div>
    </div>
  )
}

const diffStyle = {
  '--diffs-font-size': '13px',
  '--diffs-font-family': 'monospace',
  '--diffs-bg-separator-override': '#1c2333',
} as React.CSSProperties

function DiffView() {
  const isWide = useIsWide()
  const { data, error, isLoading } = useQuery<DiffData>({
    queryKey: ['diff'],
    queryFn: () => fetch('/api/diff').then((r) => r.json()),
  })

  if (isLoading) return <div style={{ padding: 20 }}>Loading...</div>
  if (error) return <pre style={{ color: 'red', padding: 20 }}>{String(error)}</pre>
  if (data!.error) return <pre style={{ color: 'red', padding: 20 }}>{data!.error}</pre>
  if (!data!.patch) return <div style={{ padding: 20 }}>No changes in {data!.revset}</div>

  const { fileHashes, viewed } = data!
  const patches = parsePatchFiles(data!.patch!)
  const files = patches.flatMap((p) => p.files)

  return (
    <div className="diff-container">
      <ProgressBar fileHashes={fileHashes} viewed={viewed} />
      {files.map((fileDiff, i) => (
        <div key={fileDiff.name ?? i} className="file-card">
          <FileHeader fileDiff={fileDiff} fileHashes={fileHashes} viewed={viewed} />
          <FileDiff
            style={diffStyle}
            fileDiff={fileDiff}
            options={{
              theme: 'github-dark-default',
              diffStyle: isWide ? 'split' : 'unified',
              diffIndicators: 'classic',
              hunkSeparators: 'line-info-basic',
              overflow: 'wrap',
              disableFileHeader: true,
            }}
          />
        </div>
      ))}
    </div>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DiffView />
    </QueryClientProvider>
  )
}
