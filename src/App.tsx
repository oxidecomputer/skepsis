import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs'
import type { DiffResponse, ViewedMap, FileHashes } from '../shared/types.ts'

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

// --- Review comment types and detection ---

type AnnotationMeta =
  | { type: 'review'; line: number; text: string; file: string }
  | { type: 'composing'; file: string }

const REVIEW_PATTERN =
  /^\s*(?:\/\/|#|--|\/\*|<!--)\s*REVIEW:\s*(.*?)(?:\s*(?:\*\/|-->))?\s*$/

/** Walk the addition side of a diff and find lines matching // REVIEW: ... */
function detectReviewComments(
  fileDiff: FileDiffMetadata,
  fileName: string,
): DiffLineAnnotation<AnnotationMeta>[] {
  const annotations: DiffLineAnnotation<AnnotationMeta>[] = []
  for (const hunk of fileDiff.hunks) {
    for (let i = 0; i < hunk.additionCount; i++) {
      const lineText = fileDiff.additionLines[hunk.additionLineIndex + i]
      const match = lineText?.match(REVIEW_PATTERN)
      if (match) {
        const line = hunk.additionStart + i
        annotations.push({
          side: 'additions',
          lineNumber: line,
          metadata: { type: 'review', line, text: match[1]!.trim(), file: fileName },
        })
      }
    }
  }
  return annotations
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
  '--diffs-modified-color-override': '#1f6feb',
} as React.CSSProperties

// --- Comment form ---

function CommentForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <div className="comment-form" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
            e.preventDefault()
            onSubmit(text.trim())
          }
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Leave a review comment... (Cmd+Enter to submit)"
        rows={3}
      />
      <div className="comment-form-actions">
        <button className="comment-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="comment-submit"
          disabled={!text.trim()}
          onClick={() => text.trim() && onSubmit(text.trim())}
        >
          Comment
        </button>
      </div>
    </div>
  )
}

// --- Diff rendering with annotation support ---

const MemoizedFileDiff = memo(
  function MemoizedFileDiff({
    fileDiff,
    isWide,
    lineAnnotations,
    renderAnnotation,
    onGutterUtilityClick,
  }: {
    fileDiff: FileDiffMetadata
    isWide: boolean
    lineAnnotations: DiffLineAnnotation<AnnotationMeta>[]
    renderAnnotation: (a: DiffLineAnnotation<AnnotationMeta>) => React.ReactNode
    onGutterUtilityClick: (range: { start: number; end: number; side?: string }) => void
  }) {
    return (
      <FileDiff<AnnotationMeta>
        style={fileDiffStyle}
        fileDiff={fileDiff}
        options={{
          theme: 'github-dark-default',
          diffStyle: isWide ? 'split' : 'unified',
          diffIndicators: 'classic',
          hunkSeparators: 'line-info-basic',
          overflow: 'wrap',
          disableFileHeader: true,
          enableGutterUtility: true,
          onGutterUtilityClick,
        }}
        lineAnnotations={lineAnnotations}
        renderAnnotation={renderAnnotation}
      />
    )
  },
  (prev, next) =>
    prev.fileDiff === next.fileDiff &&
    prev.isWide === next.isWide &&
    prev.lineAnnotations === next.lineAnnotations,
)

// --- FileCard ---

function FileCard({
  fileDiff,
  hash,
  isViewed,
  isStale,
  isWide,
  collapsed,
  composing,
  onToggleCollapse,
  onToggleViewed,
  onStartComment,
  onSubmitComment,
  onResolveComment,
  onCancelComment,
}: {
  fileDiff: FileDiffMetadata
  hash: string | undefined
  isViewed: boolean
  isStale: boolean
  isWide: boolean
  collapsed: boolean
  composing: { line: number } | null
  onToggleCollapse: () => void
  onToggleViewed: () => void
  onStartComment: (line: number) => void
  onSubmitComment: (line: number, text: string) => void
  onResolveComment: (line: number) => void
  onCancelComment: () => void
}) {
  const { additions, deletions } = getFileStats(fileDiff)
  const name = fileDiff.name

  // Build annotation list: detected REVIEW comments + composing form
  const lineAnnotations = useMemo(() => {
    const annotations = detectReviewComments(fileDiff, name)
    if (composing) {
      annotations.push({
        side: 'additions' as const,
        lineNumber: composing.line,
        metadata: { type: 'composing' as const, file: name },
      })
    }
    return annotations
  }, [fileDiff, name, composing])

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = annotation.metadata
      if (meta.type === 'review') {
        return (
          <div className="review-annotation">
            <button className="resolve-button" onClick={() => onResolveComment(meta.line)}>
              Resolve
            </button>
          </div>
        )
      }
      if (meta.type === 'composing') {
        return (
          <CommentForm
            onSubmit={(text) => onSubmitComment(annotation.lineNumber, text)}
            onCancel={onCancelComment}
          />
        )
      }
      return null
    },
    [onResolveComment, onSubmitComment, onCancelComment],
  )

  const onGutterUtilityClick = useCallback(
    (range: { start: number; end: number; side?: string }) => {
      if (range.side === 'additions') {
        onStartComment(range.start)
      }
    },
    [onStartComment],
  )

  return (
    <div className="file-card">
      <div className="file-header" onClick={onToggleCollapse}>
        <span className={'collapse-chevron' + (collapsed ? ' collapsed' : '')}>
          {'\u25B6'}
        </span>
        <span className="file-header-name">{name}</span>
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
        <MemoizedFileDiff
          fileDiff={fileDiff}
          isWide={isWide}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          onGutterUtilityClick={onGutterUtilityClick}
        />
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
  const [composing, setComposing] = useState<{ file: string; line: number } | null>(null)
  const seededFromInitialLoad = useRef(false)
  const { data, error, isLoading } = useQuery<DiffResponse>({
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
        body: JSON.stringify({ file, hash }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['diff'] }),
  })

  const commentMutation = useMutation({
    mutationFn: ({
      file,
      afterLine,
      text,
    }: {
      file: string
      afterLine: number
      text: string
    }) =>
      fetch('/api/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, afterLine, text }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['diff'] }),
  })

  const resolveMutation = useMutation({
    mutationFn: ({ file, line }: { file: string; line: number }) =>
      fetch('/api/comment', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, line }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['diff'] }),
  })

  // Memoize patch parsing so it doesn't re-run on viewed state changes
  const patch = data?.patch
  const files = useMemo(
    () => (patch ? parsePatchFiles(patch).flatMap((p) => p.files) : []),
    [patch],
  )

  // Derive optimistic viewed state from pending mutation
  const viewed = useMemo(() => {
    const base = { ...(data?.viewed ?? {}) }
    if (markMutation.isPending && markMutation.variables) {
      const { file, hash, mark } = markMutation.variables
      if (mark) base[file] = hash
      else delete base[file]
    }
    return base
  }, [data, markMutation.isPending, markMutation.variables])

  if (isLoading) return <div style={{ padding: 20 }}>Loading...</div>
  if (error) return <pre style={{ color: 'red', padding: 20 }}>{String(error)}</pre>
  if (data!.error) return <pre style={{ color: 'red', padding: 20 }}>{data!.error}</pre>
  if (!patch) return <div style={{ padding: 20 }}>No changes in {data!.revset}</div>

  const { fileHashes } = data!

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
        const fileComposing = composing?.file === name ? { line: composing.line } : null

        return (
          <FileCard
            key={name ?? i}
            fileDiff={fileDiff}
            hash={hash}
            isViewed={isViewed}
            isStale={isStale}
            isWide={isWide}
            collapsed={isCollapsed}
            composing={fileComposing}
            onToggleCollapse={() =>
              setCollapsed((prev) => ({ ...prev, [name]: !isCollapsed }))
            }
            onToggleViewed={() => {
              if (hash) {
                const mark = !isViewed
                setCollapsed((prev) => ({ ...prev, [name]: mark }))
                markMutation.mutate({ file: name, hash, mark })
              }
            }}
            onStartComment={(line) => setComposing({ file: name, line })}
            onSubmitComment={(line, text) => {
              commentMutation.mutate({ file: name, afterLine: line, text })
              setComposing(null)
            }}
            onResolveComment={(line) => resolveMutation.mutate({ file: name, line })}
            onCancelComment={() => setComposing(null)}
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
