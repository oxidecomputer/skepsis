import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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

const fileDiffStyle = {
  '--diffs-font-size': '13px',
  '--diffs-font-family': 'monospace',
  '--diffs-bg-separator-override': '#1c2333',
} as React.CSSProperties

/** Memoized wrapper so FileDiff doesn't re-render when only viewed/collapse state changes */
const MemoizedFileDiff = memo(function MemoizedFileDiff({
  fileDiff,
  isWide,
}: {
  fileDiff: FileDiffMetadata
  isWide: boolean
}) {
  return (
    <FileDiff
      style={fileDiffStyle}
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
  )
})

function FileCard({
  fileDiff,
  hash,
  isViewed,
  isStale,
  isWide,
  collapsed,
  onToggleCollapse,
  onToggleViewed,
}: {
  fileDiff: FileDiffMetadata
  hash: string | undefined
  isViewed: boolean
  isStale: boolean
  isWide: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onToggleViewed: () => void
}) {
  const { additions, deletions } = getFileStats(fileDiff)

  return (
    <div className="file-card">
      <div className="file-header" onClick={onToggleCollapse}>
        <span className={'collapse-chevron' + (collapsed ? ' collapsed' : '')}>
          {'\u25B6'}
        </span>
        <span className="file-header-name">{fileDiff.name}</span>
        <span className="file-header-stats">
          {additions > 0 && <span className="stat-add">+{additions}</span>}
          {deletions > 0 && <span className="stat-del">-{deletions}</span>}
        </span>
        <button
          className={
            'viewed-button' + (isStale ? ' stale' : '') + (isViewed ? ' checked' : '')
          }
          onClick={(e) => {
            e.stopPropagation()
            onToggleViewed()
          }}
        >
          <input
            type="checkbox"
            className={'viewed-checkbox' + (isStale ? ' stale' : '')}
            checked={isViewed}
            readOnly
            tabIndex={-1}
          />
          {isStale ? 'Changed' : 'Viewed'}
        </button>
      </div>
      <div style={collapsed ? { display: 'none' } : undefined}>
        <MemoizedFileDiff fileDiff={fileDiff} isWide={isWide} />
      </div>
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

function DiffView() {
  const isWide = useIsWide()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const seededFromInitialLoad = useRef(false)
  const { data, error, isLoading } = useQuery<DiffData>({
    queryKey: ['diff'],
    queryFn: () => fetch('/api/diff').then((r) => r.json()),
  })

  // Seed collapse state from the first successful fetch: viewed files start collapsed
  useEffect(() => {
    if (seededFromInitialLoad.current || !data?.fileHashes) return
    seededFromInitialLoad.current = true
    const initial: Record<string, boolean> = {}
    for (const [file, hash] of Object.entries(data.fileHashes)) {
      if (data.viewed[file] === hash) {
        initial[file] = true
      }
    }
    setCollapsed(initial)
  }, [data])

  const qc = useQueryClient()

  const markMutation = useMutation({
    mutationFn: ({ file, hash, mark }: { file: string; hash: string; mark: boolean }) =>
      fetch('/api/viewed', {
        method: mark ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mark ? { file, hash } : { file }),
      }),
    onMutate: async ({ file, hash, mark }) => {
      await qc.cancelQueries({ queryKey: ['diff'] })
      const previous = qc.getQueryData<DiffData>(['diff'])
      qc.setQueryData<DiffData>(['diff'], (old) => {
        if (!old) return old
        const newViewed = { ...old.viewed }
        if (mark) {
          newViewed[file] = hash
        } else {
          delete newViewed[file]
        }
        return { ...old, viewed: newViewed }
      })
      setCollapsed((prev) => ({ ...prev, [file]: mark }))
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(['diff'], context.previous)
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['diff'] }),
  })

  // Memoize patch parsing so it doesn't re-run on viewed state changes
  const patch = data?.patch
  const files = useMemo(
    () => (patch ? parsePatchFiles(patch).flatMap((p) => p.files) : []),
    [patch],
  )

  if (isLoading) return <div style={{ padding: 20 }}>Loading...</div>
  if (error) return <pre style={{ color: 'red', padding: 20 }}>{String(error)}</pre>
  if (data!.error) return <pre style={{ color: 'red', padding: 20 }}>{data!.error}</pre>
  if (!patch) return <div style={{ padding: 20 }}>No changes in {data!.revset}</div>

  const { fileHashes, viewed } = data!

  return (
    <div className="diff-container">
      <ProgressBar fileHashes={fileHashes} viewed={viewed} />
      {files.map((fileDiff, i) => {
        const name = fileDiff.name
        const hash = fileHashes[name]
        const viewedHash = viewed[name]
        const isViewed = hash != null && viewedHash === hash
        const isStale = viewedHash != null && hash != null && viewedHash !== hash
        const isCollapsed = collapsed[name] ?? false

        return (
          <FileCard
            key={name ?? i}
            fileDiff={fileDiff}
            hash={hash}
            isViewed={isViewed}
            isStale={isStale}
            isWide={isWide}
            collapsed={isCollapsed}
            onToggleCollapse={() =>
              setCollapsed((prev) => ({ ...prev, [name]: !isCollapsed }))
            }
            onToggleViewed={() => {
              if (hash) markMutation.mutate({ file: name, hash, mark: !isViewed })
            }}
          />
        )
      })}
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
