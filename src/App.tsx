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
  useLayoutEffect,
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

const wideQuery = '(min-width: 1060px)'

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

function useToast(duration = 1500) {
  const [toast, setToast] = useState<{ content: React.ReactNode; key: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const key = useRef(0)
  const showToast = useCallback(
    (content: React.ReactNode) => {
      clearTimeout(timer.current)
      setToast({ content, key: ++key.current })
      timer.current = setTimeout(() => setToast(null), duration)
    },
    [duration],
  )
  return { toast, showToast }
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

// --- Keyboard navigation helpers ---

/** Query shadow DOM for navigable diff lines in a file card */
function getFileLines(fileIdx: number) {
  const cards = document.querySelectorAll('.file-card')
  const card = cards[fileIdx]
  if (!card) return []

  const container = card.querySelector('diffs-container')
  const pre = (container as HTMLElement | null)?.shadowRoot?.querySelector('pre')
  if (!pre) return []

  const results: Array<{
    gutterEl: HTMLElement
    contentEl: HTMLElement
    lineNumber: number
    lineType: string
  }> = []

  for (const col of Array.from(pre.children)) {
    if (!(col instanceof HTMLElement) || !col.hasAttribute('data-code')) continue
    // In split mode skip deletions column; navigate additions only
    if (col.hasAttribute('data-deletions')) continue

    const gutter = col.querySelector('[data-gutter]')
    const content = col.querySelector('[data-content]')
    if (!gutter || !content) continue

    for (let i = 0; i < gutter.children.length && i < content.children.length; i++) {
      const g = gutter.children[i] as HTMLElement
      const c = content.children[i] as HTMLElement
      if (!g.hasAttribute('data-column-number')) continue
      results.push({
        gutterEl: g,
        contentEl: c,
        lineNumber: parseInt(g.getAttribute('data-column-number')!, 10),
        lineType: g.getAttribute('data-line-type') || '',
      })
    }
    break // one column is enough
  }
  return results
}

/** Bottom edge of the sticky file header — lines above this are occluded */
function stickyHeaderBottom(fileIdx: number): number {
  const card = document.querySelectorAll('.file-card')[fileIdx]
  const header = card?.querySelector('.file-header')
  return header ? header.getBoundingClientRect().bottom : 0
}

/** Find the index of the first visible line in a file card, or -1.
 *  Accounts for the sticky file header that occludes the top of the card. */
function firstVisibleLineIdx(fileIdx: number): number {
  const top = stickyHeaderBottom(fileIdx)
  const lines = getFileLines(fileIdx)
  for (let i = 0; i < lines.length; i++) {
    const rect = lines[i]!.contentEl.getBoundingClientRect()
    if (rect.bottom > top && rect.top < window.innerHeight) return i
  }
  return -1
}

/** Is a line element visible below the sticky header and above the viewport bottom? */
function isLineVisible(el: HTMLElement, fileIdx: number): boolean {
  const r = el.getBoundingClientRect()
  return r.bottom > stickyHeaderBottom(fileIdx) && r.top < window.innerHeight
}

function clearCursorHighlight() {
  for (const container of document.querySelectorAll('.file-card diffs-container')) {
    const sr = (container as HTMLElement).shadowRoot
    if (!sr) continue
    for (const el of sr.querySelectorAll('[data-selected-line]')) {
      el.removeAttribute('data-selected-line')
    }
  }
}

/** Inject cursor-line CSS into a shadow root (idempotent) */
function ensureCursorStyles(sr: ShadowRoot) {
  if (sr.querySelector('style[data-cursor-css]')) return
  const style = document.createElement('style')
  style.setAttribute('data-cursor-css', '')
  // The library only styles change lines with data-selected-line;
  // this covers context lines too.
  style.textContent =
    '[data-selected-line][data-line] { background-color: var(--diffs-bg-selection); }'
  sr.appendChild(style)
}

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

// Measured per-line height from the first rendered diff, used for placeholder sizing.
// Falls back to 20px until a real measurement is taken.
let measuredLineHeight = 20
let lineHeightMeasured = false

const MemoizedFileDiff = memo(
  function MemoizedFileDiff({
    fileDiff,
    diffStyle,
    lineAnnotations,
    renderAnnotation,
    onGutterUtilityClick,
    commentsEnabled,
  }: {
    fileDiff: FileDiffMetadata
    diffStyle: 'split' | 'unified'
    lineAnnotations: DiffLineAnnotation<AnnotationMeta>[]
    renderAnnotation: (a: DiffLineAnnotation<AnnotationMeta>) => React.ReactNode
    onGutterUtilityClick: (range: { start: number; end: number; side?: string }) => void
    commentsEnabled: boolean
  }) {
    const measureRef = useCallback(
      (el: HTMLDivElement | null) => {
        if (lineHeightMeasured || !el) return
        // Measure after the web component has rendered into its shadow DOM
        requestAnimationFrame(() => {
          const lineCount =
            diffStyle === 'split' ? fileDiff.splitLineCount : fileDiff.unifiedLineCount
          if (lineCount > 0 && el.offsetHeight > 0) {
            measuredLineHeight = el.offsetHeight / lineCount
            lineHeightMeasured = true
          }
        })
      },
      [fileDiff, diffStyle],
    )
    return (
      <div ref={measureRef}>
        <FileDiff<AnnotationMeta>
          fileDiff={fileDiff}
          options={{
            theme: 'github-dark-default',
            diffStyle,
            diffIndicators: 'classic',
            hunkSeparators: 'line-info-basic',
            overflow: 'wrap',
            disableFileHeader: true,
            enableGutterUtility: commentsEnabled,
            onGutterUtilityClick,
          }}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
        />
      </div>
    )
  },
  (prev, next) =>
    prev.fileDiff === next.fileDiff &&
    prev.diffStyle === next.diffStyle &&
    prev.lineAnnotations === next.lineAnnotations,
)

// --- FileCard ---

function FileCard({
  fileDiff,
  isViewed,
  isStale,
  diffStyle,
  collapsed,
  composing,
  focused,
  onToggleCollapse,
  onToggleViewed,
  onStartComment,
  onSubmitComment,
  onResolveComment,
  onCancelComment,
  commentsEnabled,
}: {
  fileDiff: FileDiffMetadata
  isViewed: boolean
  isStale: boolean
  diffStyle: 'split' | 'unified'
  collapsed: boolean
  composing: { line: number } | null
  focused: boolean
  onToggleCollapse: () => void
  onToggleViewed: () => void
  onStartComment: (line: number) => void
  onSubmitComment: (line: number, text: string) => void
  onResolveComment: (line: number) => void
  onCancelComment: () => void
  commentsEnabled: boolean
}) {
  const { additions, deletions } = getFileStats(fileDiff)
  const name = fileDiff.name

  // Build annotation list: detected REVIEW comments + composing form
  const lineAnnotations = useMemo(() => {
    if (!commentsEnabled) return []
    const annotations = detectReviewComments(fileDiff, name)
    if (composing) {
      annotations.push({
        side: 'additions' as const,
        lineNumber: composing.line,
        metadata: { type: 'composing' as const, file: name },
      })
    }
    return annotations
  }, [fileDiff, name, composing, commentsEnabled])

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
      if (commentsEnabled && range.side === 'additions') {
        onStartComment(range.start)
      }
    },
    [onStartComment, commentsEnabled],
  )

  // Lazy mount: only create the FileDiff web component when near the viewport
  const cardRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: '2000px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const showDiff = nearViewport && !collapsed

  // Estimate height for placeholder to prevent layout shift
  const lineCount =
    diffStyle === 'split' ? fileDiff.splitLineCount : fileDiff.unifiedLineCount
  const estimatedHeight = lineCount * measuredLineHeight

  return (
    <div ref={cardRef} className={'file-card' + (focused ? ' focused' : '')}>
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
      {showDiff ? (
        <MemoizedFileDiff
          fileDiff={fileDiff}
          diffStyle={diffStyle}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          onGutterUtilityClick={onGutterUtilityClick}
          commentsEnabled={commentsEnabled}
        />
      ) : (
        !collapsed && <div style={{ height: estimatedHeight }} />
      )}
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

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])

  return (
    <dialog
      ref={ref}
      className="help-modal"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close()
      }}
    >
      {children}
    </dialog>
  )
}

const SHORTCUTS: [string, string][] = [
  ['j / k', 'Next / previous line'],
  ['n / p', 'Next / previous file'],
  ['v', 'Toggle viewed'],
  ['e / E', 'Toggle collapse file / all files'],
  ['s', 'Toggle split mode (responsive / unified)'],
  ['c', 'Comment on line'],
  ['Esc', 'Close / cancel'],
  ['?', 'Toggle this help'],
]

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>Keyboard Shortcuts</h3>
      <table>
        <tbody>
          {SHORTCUTS.map(([keys, desc]) => (
            <tr key={keys}>
              <td>
                {keys.split(' / ').map((k, i) => (
                  <span key={k}>
                    {i > 0 && ' / '}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

function CommentsModal({ onClose, vcs }: { onClose: () => void; vcs: 'jj' | 'git' }) {
  return (
    <Modal onClose={onClose}>
      <p>
        Comments work by inserting lines into the code. This can only work if the{' '}
        {vcs === 'jj' ? (
          <>
            revset includes <code>@</code>
          </>
        ) : (
          'commit range includes the working copy'
        )}
        . Otherwise, the inserted lines will land in{' '}
        {vcs === 'jj' ? <code>@</code> : 'the working copy'} but not in the diff being
        viewed.
      </p>
      {vcs === 'jj' ? (
        <p>
          The easiest way to get a diff with comments enabled is to run with the{' '}
          <code>-f</code> flag to get a diff that starts at some revision and ends at{' '}
          <code>@</code>.
        </p>
      ) : (
        <p>
          The easiest way to get a diff with comments enabled is to run with <code>-f</code>{' '}
          only (no <code>-t</code>), so the diff goes from a commit to the working tree.
        </p>
      )}
    </Modal>
  )
}

function CommentsDisabledBanner({
  onLearnMore,
  vcs,
}: {
  onLearnMore: () => void
  vcs: 'jj' | 'git'
}) {
  return (
    <div className="comments-disabled-banner">
      {vcs === 'jj' ? (
        <>
          Comments are disabled because the revset does not include <code>@</code>.
        </>
      ) : (
        'Comments are disabled because the commit range does not end at the working copy.'
      )}{' '}
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault()
          onLearnMore()
        }}
      >
        Learn more
      </a>
    </div>
  )
}

type SplitMode = 'responsive' | 'unified'
const SPLIT_CYCLE: SplitMode[] = ['responsive', 'unified']

function DiffView() {
  const isWide = useIsWide()
  const [splitMode, setSplitMode] = useState<SplitMode>('responsive')
  const diffStyle: 'split' | 'unified' =
    splitMode === 'responsive' && isWide ? 'split' : 'unified'
  const { toast, showToast } = useToast()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [composing, setComposing] = useState<{ file: string; line: number } | null>(null)
  const seededFromInitialLoad = useRef(false)
  const { data, error, isLoading } = useQuery<DiffResponse>({
    queryKey: ['diff'],
    queryFn: () => fetch('/api/diff').then((r) => r.json()),
  })

  useEffect(() => {
    if (data?.revset) document.title = `skepsis | ${data.revset}`
  }, [data?.revset])

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

  // --- Keyboard navigation ---
  const [focusedFileIdx, setFocusedFileIdx] = useState(0)
  const [cursorIdx, setCursorIdx] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [showCommentsInfo, setShowCommentsInfo] = useState(false)
  const scrollRef = useRef<'file' | 'line' | null>(null)
  const keyboardNavTime = useRef(0)

  // Mutable snapshot for the keyboard handler (avoids re-creating the listener)
  const navRef = useRef({
    focusedFileIdx: 0,
    cursorIdx: 0,
    showHelp: false,
    composing: null as typeof composing,
    files: [] as FileDiffMetadata[],
    collapsed: {} as Record<string, boolean>,
    fileHashes: {} as Record<string, string>,
    viewed: {} as ViewedMap,
    markMutate: markMutation.mutate,
  })
  navRef.current = {
    focusedFileIdx,
    cursorIdx,
    showHelp,
    composing,
    files,
    collapsed,
    fileHashes: data?.fileHashes ?? {},
    viewed,
    markMutate: markMutation.mutate,
  }

  // Apply cursor highlight after state or DOM changes
  useLayoutEffect(() => {
    clearCursorHighlight()

    const target = scrollRef.current
    scrollRef.current = null

    if (target === 'file') {
      const cards = document.querySelectorAll('.file-card')
      cards[focusedFileIdx]?.scrollIntoView({ block: 'start' })
    }

    const file = files[focusedFileIdx]
    if (!file || (collapsed[file.name] ?? false)) return

    const lines = getFileLines(focusedFileIdx)
    const idx = Math.min(cursorIdx, Math.max(lines.length - 1, 0))
    const line = lines[idx]
    if (!line) return

    // Inject cursor CSS into this file's shadow root
    const sr = line.gutterEl.getRootNode() as ShadowRoot
    if (sr instanceof ShadowRoot) ensureCursorStyles(sr)

    line.gutterEl.setAttribute('data-selected-line', 'single')
    line.contentEl.setAttribute('data-selected-line', 'single')

    if (target === 'line') {
      line.contentEl.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedFileIdx, cursorIdx, patch, composing, collapsed, files])

  // Keyboard handler (stable — reads mutable ref)
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
        return
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const s = navRef.current

      switch (e.key) {
        case '?':
          e.preventDefault()
          setShowHelp((v) => !v)
          break
        case 'Escape':
          if (s.showHelp) {
            e.preventDefault()
            setShowHelp(false)
          } else if (s.composing) {
            e.preventDefault()
            setComposing(null)
          }
          break
        case 'n':
        case 'p': {
          if (s.showHelp || s.composing) break
          e.preventDefault()
          const delta = e.key === 'n' ? 1 : -1
          const next = Math.max(0, Math.min(s.focusedFileIdx + delta, s.files.length - 1))
          if (next !== s.focusedFileIdx) {
            keyboardNavTime.current = Date.now()
            setFocusedFileIdx(next)
            setCursorIdx(0)
            scrollRef.current = 'file'
          }
          break
        }
        case 'j':
        case 'k': {
          if (s.showHelp || s.composing) break
          e.preventDefault()
          const name = s.files[s.focusedFileIdx]?.name
          if (!name || (s.collapsed[name] ?? false)) break
          const lines = getFileLines(s.focusedFileIdx)
          if (lines.length === 0) break
          // If cursor is off-screen (or behind sticky header), snap to first visible line
          let base = s.cursorIdx
          const cur = lines[Math.min(base, lines.length - 1)]
          if (cur && !isLineVisible(cur.contentEl, s.focusedFileIdx)) {
            const vis = firstVisibleLineIdx(s.focusedFileIdx)
            if (vis >= 0) base = vis
          }
          const moved = Math.max(
            0,
            Math.min(base + (e.key === 'j' ? 1 : -1), lines.length - 1),
          )
          if (moved !== s.cursorIdx) {
            keyboardNavTime.current = Date.now()
            setCursorIdx(moved)
            scrollRef.current = 'line'
          }
          break
        }
        case 'v': {
          if (s.showHelp || s.composing) break
          e.preventDefault()
          const file = s.files[s.focusedFileIdx]
          if (!file) break
          const hash = s.fileHashes[file.name]
          if (!hash) break
          const isViewed = s.viewed[file.name] === hash
          const mark = !isViewed
          setCollapsed((prev) => ({ ...prev, [file.name]: mark }))
          s.markMutate({ file: file.name, hash, mark })
          break
        }
        case 'e': {
          if (s.showHelp || s.composing) break
          e.preventDefault()
          const file = s.files[s.focusedFileIdx]
          if (!file) break
          keyboardNavTime.current = Date.now()
          setCollapsed((prev) => ({
            ...prev,
            [file.name]: !(prev[file.name] ?? false),
          }))
          break
        }
        case 'E': {
          if (s.showHelp || s.composing) break
          e.preventDefault()
          keyboardNavTime.current = Date.now()
          // If any file is expanded, collapse all; otherwise expand all
          const anyExpanded = s.files.some((f) => !(s.collapsed[f.name] ?? false))
          setCollapsed(Object.fromEntries(s.files.map((f) => [f.name, anyExpanded])))
          break
        }
        case 's': {
          if (s.showHelp || s.composing) break
          e.preventDefault()
          setSplitMode((prev) => {
            const next = SPLIT_CYCLE[(SPLIT_CYCLE.indexOf(prev) + 1) % SPLIT_CYCLE.length]!
            showToast(
              <>
                Split mode: <code>{next}</code>
              </>,
            )
            return next
          })
          break
        }
        case 'c': {
          if (!data?.commentsEnabled || s.showHelp || s.composing) break
          e.preventDefault()
          const file = s.files[s.focusedFileIdx]
          if (!file) break
          if (s.collapsed[file.name] ?? false) break
          const lines = getFileLines(s.focusedFileIdx)
          const line = lines[s.cursorIdx]
          if (!line || line.lineType === 'change-deletion') break
          setComposing({ file: file.name, line: line.lineNumber })
          break
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Track which file the user is looking at via IntersectionObserver.
  // Fires only on visibility transitions — no per-frame work.
  const visibleCards = useRef(new Set<number>())
  useEffect(() => {
    visibleCards.current.clear()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.fileIdx)
          if (entry.isIntersecting) visibleCards.current.add(idx)
          else visibleCards.current.delete(idx)
        }

        // Don't override keyboard-driven navigation
        if (Date.now() - keyboardNavTime.current < 150) return
        if (visibleCards.current.size === 0) return
        const topIdx = Math.min(...visibleCards.current)
        const s = navRef.current
        if (topIdx !== s.focusedFileIdx) {
          setFocusedFileIdx(topIdx)
          // Snap cursor to first visible line in the new file
          const file = s.files[topIdx]
          if (file && !(s.collapsed[file.name] ?? false)) {
            const vis = firstVisibleLineIdx(topIdx)
            if (vis >= 0) setCursorIdx(vis)
          }
        }
      },
      { threshold: 0 },
    )

    const cards = document.querySelectorAll('.file-card')
    cards.forEach((card, i) => {
      ;(card as HTMLElement).dataset.fileIdx = String(i)
      observer.observe(card)
    })

    return () => observer.disconnect()
  }, [files])

  if (isLoading || !data) return <div className="empty-diff">Loading...</div>
  if (error) return <pre style={{ color: 'red', padding: 20 }}>{String(error)}</pre>
  if (data.error) return <pre style={{ color: 'red', padding: 20 }}>{data.error}</pre>
  if (!patch)
    return (
      <div className="empty-diff">
        <code>{data.revset}</code> is empty
      </div>
    )

  const { fileHashes } = data

  return (
    <>
      {!data.commentsEnabled && (
        <CommentsDisabledBanner
          vcs={data.vcs}
          onLearnMore={() => setShowCommentsInfo(true)}
        />
      )}
      <div className="diff-container">
        <ProgressBar fileHashes={fileHashes} viewed={viewed} />
        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {showCommentsInfo && (
          <CommentsModal vcs={data.vcs} onClose={() => setShowCommentsInfo(false)} />
        )}
        {toast && (
          <div className="toast" key={toast.key}>
            {toast.content}
          </div>
        )}
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
              isViewed={isViewed}
              isStale={isStale}
              diffStyle={diffStyle}
              collapsed={isCollapsed}
              composing={fileComposing}
              focused={i === focusedFileIdx}
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
              commentsEnabled={data.commentsEnabled}
            />
          )
        })}
      </div>
    </>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DiffView />
    </QueryClientProvider>
  )
}
