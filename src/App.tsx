/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { parsePatchFiles } from '@pierre/diffs'
import { CodeView } from '@pierre/diffs/react'
import type { CodeViewHandle } from '@pierre/diffs/react'
import type {
  CodeViewDiffItem,
  CodeViewItem,
  CodeViewOptions,
  DiffLineAnnotation,
  FileDiffMetadata,
  LineAnnotation,
  SelectedLineRange,
} from '@pierre/diffs'
import type { DiffResponse, ErrorResponse, ViewedMap, FileHashes } from '../shared/types.ts'
import { REVIEW_CLOSE_PATTERN, REVIEW_OPEN_PATTERN } from '../shared/reviewComments.ts'

const queryClient = new QueryClient()

async function apiFetch<T = unknown>(
  url: string,
  opts: { method: string; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const res = await fetch(url, {
    method: opts.method,
    headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ErrorResponse | null
    throw new Error(err?.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

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
  const [toast, setToast] = useState<{
    content: React.ReactNode
    key: number
  } | null>(null)
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
  | { type: 'review'; startLine: number; endLine: number; file: string }
  | { type: 'composing'; file: string }

/** Walk the addition side of a diff and find <review>...</review> blocks. */
function detectReviewComments(
  fileDiff: FileDiffMetadata,
  fileName: string,
): DiffLineAnnotation<AnnotationMeta>[] {
  const annotations: DiffLineAnnotation<AnnotationMeta>[] = []
  for (const hunk of fileDiff.hunks) {
    let openLine: number | null = null
    for (let i = 0; i < hunk.additionCount; i++) {
      const lineText = fileDiff.additionLines[hunk.additionLineIndex + i]
      if (!lineText) continue
      const absLine = hunk.additionStart + i
      if (REVIEW_OPEN_PATTERN.test(lineText)) {
        openLine = absLine
      } else if (REVIEW_CLOSE_PATTERN.test(lineText) && openLine !== null) {
        annotations.push({
          side: 'additions',
          lineNumber: absLine,
          metadata: {
            type: 'review',
            startLine: openLine,
            endLine: absLine,
            file: fileName,
          },
        })
        openLine = null
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

// --- Review-comment line highlighting ---

// Injected into every CodeView item's shadow root via the `unsafeCSS` option.
// Lines inside a <review> block get `data-review-comment` tagged onto them in
// `tagReviewLines` (called from CodeView's onPostRender), and this styles them.
const REVIEW_CSS = `
  [data-review-comment] {
    --diffs-bg-addition: rgba(56, 139, 253, 0.14) !important;
    --diffs-addition-base: rgba(56, 139, 253, 0.85) !important;
    --diffs-fg-number-addition-override: var(--diffs-fg-number) !important;
  }
  [data-review-comment][data-line] *,
  [data-review-comment][data-no-newline] * {
    color: var(--diffs-fg) !important;
  }
  [data-review-comment] [data-gutter-utility-slot] { display: none !important; }
  /* The comment "+" only works on the additions side (comments are inserted
     after an addition/context line in the new file). Hide it on the deletions
     side — the whole left column in split mode, and change-deletion lines in
     unified mode — so it doesn't appear where clicking is a no-op. */
  [data-deletions] [data-gutter-utility-slot],
  [data-line-type='change-deletion'] [data-gutter-utility-slot] {
    display: none !important;
  }
`

/**
 * Tag addition lines within review-block ranges with `data-review-comment` so
 * REVIEW_CSS can style them. `node` is the item's `diffs-container` element;
 * we re-derive tags from scratch each call so recycled (pooled) elements never
 * carry stale highlights from a previously-rendered file.
 */
function tagReviewLines(
  node: HTMLElement,
  ranges: Array<{ start: number; end: number }>,
): void {
  const sr = node.shadowRoot
  const pre = sr?.querySelector('pre')
  if (!pre) return

  for (const el of sr!.querySelectorAll('[data-review-comment]')) {
    el.removeAttribute('data-review-comment')
  }
  if (ranges.length === 0) return

  const inRange = (n: number) => ranges.some((r) => n >= r.start && n <= r.end)

  for (const col of Array.from(pre.children)) {
    if (!(col instanceof HTMLElement) || !col.hasAttribute('data-code')) continue
    if (col.hasAttribute('data-deletions')) continue
    const gutter = col.querySelector('[data-gutter]')
    const content = col.querySelector('[data-content]')
    if (!gutter || !content) continue
    for (let i = 0; i < gutter.children.length && i < content.children.length; i++) {
      const g = gutter.children[i] as HTMLElement
      const c = content.children[i] as HTMLElement
      if (g.getAttribute('data-line-type') !== 'change-addition') continue
      const numAttr = g.getAttribute('data-column-number')
      if (!numAttr) continue
      const lineNum = parseInt(numAttr, 10)
      if (inRange(lineNum)) {
        g.setAttribute('data-review-comment', '')
        c.setAttribute('data-review-comment', '')
      }
    }
  }
}

/** Review-block ranges for an item's annotations (used by tagReviewLines). */
function reviewRanges(
  annotations: ReadonlyArray<{ metadata?: AnnotationMeta }> | undefined,
): Array<{ start: number; end: number }> {
  return (annotations ?? []).flatMap((a) =>
    a.metadata?.type === 'review'
      ? [{ start: a.metadata.startLine, end: a.metadata.endLine }]
      : [],
  )
}

type ButtonProps = {
  variant?: 'primary' | 'secondary'
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}

function Button({ variant = 'secondary', onClick, disabled, children }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

// --- Comment form ---

function CommentForm({
  onSubmit,
  onCancel,
  submitting,
  error,
}: {
  onSubmit: (text: string) => void
  onCancel: () => void
  submitting: boolean
  error: string | null
}) {
  const [text, setText] = useState('')
  // useEffect instead of a function ref because the function ref didn't
  // actually focus the textarea on open.
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  const submit = () => {
    const body = text.trim()
    if (!body || submitting) return
    onSubmit(body)
  }

  return (
    <div className="comment-form" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Leave a review comment... (Cmd+Enter to submit)"
        rows={3}
        disabled={submitting}
      />
      <div className="comment-form-actions">
        {error && <div className="comment-form-error">{error}</div>}
        <Button onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!text.trim() || submitting} onClick={submit}>
          Comment
        </Button>
      </div>
    </div>
  )
}

// --- File header (rendered into each CodeView item's custom-header slot) ---

function FileHeader({
  fileDiff,
  isViewed,
  isStale,
  collapsed,
  onToggleCollapse,
  onToggleViewed,
}: {
  fileDiff: FileDiffMetadata
  isViewed: boolean
  isStale: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onToggleViewed: () => void
}) {
  const { additions, deletions } = getFileStats(fileDiff)
  return (
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
        type="button"
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
  const [composing, setComposing] = useState<{
    file: string
    line: number
  } | null>(null)
  const seededFromInitialLoad = useRef(false)
  const { data, error, isLoading } = useQuery({
    queryKey: ['diff'],
    queryFn: () => apiFetch<DiffResponse>('/api/diff'),
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
      apiFetch('/api/viewed', {
        method: mark ? 'POST' : 'DELETE',
        body: { file, hash },
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
      apiFetch('/api/comment', {
        method: 'POST',
        body: { file, afterLine, text },
      }),
    onSuccess: () => setComposing(null),
    onSettled: () => qc.invalidateQueries({ queryKey: ['diff'] }),
  })

  const resolveMutation = useMutation({
    mutationFn: ({ file, line }: { file: string; line: number }) =>
      apiFetch('/api/comment', {
        method: 'DELETE',
        body: { file, line },
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
    const base = { ...data?.viewed }
    if (markMutation.isPending && markMutation.variables) {
      const { file, hash, mark } = markMutation.variables
      if (mark) base[file] = hash
      else delete base[file]
    }
    return base
  }, [data, markMutation.isPending, markMutation.variables])

  const commentsEnabled = data?.commentsEnabled ?? false

  const [showHelp, setShowHelp] = useState(false)
  const [showCommentsInfo, setShowCommentsInfo] = useState(false)
  const codeViewRef = useRef<CodeViewHandle<AnnotationMeta>>(null)

  // Build the CodeView item list. CodeView only re-renders an item when its
  // `version` changes, so we bump version whenever any rendered input for a
  // file changes: its content hash (which also covers review annotations,
  // since those are derived from diff content), the composing-form line, or
  // its collapsed state.
  const versionsRef = useRef(new Map<string, { key: string; version: number }>())
  const items = useMemo<CodeViewDiffItem<AnnotationMeta>[]>(() => {
    if (!data) return []
    const { fileHashes } = data
    return files.map((fileDiff) => {
      const name = fileDiff.name
      const annotations = commentsEnabled ? detectReviewComments(fileDiff, name) : []
      if (composing?.file === name) {
        annotations.push({
          side: 'additions',
          lineNumber: composing.line,
          metadata: { type: 'composing', file: name },
        })
      }
      const isCollapsed = collapsed[name] ?? false
      const composingLine = composing?.file === name ? composing.line : -1
      const key = `${fileHashes[name] ?? ''}|${composingLine}|${isCollapsed ? 1 : 0}`
      const prev = versionsRef.current.get(name)
      const version = !prev || prev.key !== key ? (prev?.version ?? 0) + 1 : prev.version
      if (!prev || prev.key !== key) versionsRef.current.set(name, { key, version })
      return {
        id: name,
        type: 'diff',
        fileDiff,
        annotations,
        collapsed: isCollapsed,
        version,
      }
    })
  }, [files, data, composing, collapsed, commentsEnabled])

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      if (item.type !== 'diff') return null
      const name = item.id
      const hash = data?.fileHashes[name]
      const viewedHash = viewed[name]
      const isViewed = hash != null && viewedHash === hash
      const isStale = viewedHash != null && hash != null && viewedHash !== hash
      const isCollapsed = collapsed[name] ?? false
      return (
        <FileHeader
          fileDiff={item.fileDiff}
          isViewed={isViewed}
          isStale={isStale}
          collapsed={isCollapsed}
          onToggleCollapse={() =>
            setCollapsed((prev) => ({ ...prev, [name]: !isCollapsed }))
          }
          onToggleViewed={() => {
            if (!hash) return
            const mark = !isViewed
            setCollapsed((prev) => ({ ...prev, [name]: mark }))
            markMutation.mutate({ file: name, hash, mark })
          }}
        />
      )
    },
    [data, viewed, collapsed, markMutation],
  )

  const renderAnnotation = useCallback(
    (
      annotation: LineAnnotation<AnnotationMeta> | DiffLineAnnotation<AnnotationMeta>,
      item: CodeViewItem<AnnotationMeta>,
    ) => {
      const meta = annotation.metadata
      if (!meta) return null
      const file = item.id
      if (meta.type === 'review') {
        return (
          <div className="review-annotation">
            <Button onClick={() => resolveMutation.mutate({ file, line: meta.startLine })}>
              Resolve comment
            </Button>
          </div>
        )
      }
      if (meta.type === 'composing') {
        return (
          <CommentForm
            onSubmit={(text) =>
              commentMutation.mutate({
                file,
                afterLine: annotation.lineNumber,
                text,
              })
            }
            onCancel={() => setComposing(null)}
            submitting={
              commentMutation.isPending && commentMutation.variables?.file === file
            }
            error={
              commentMutation.variables?.file === file && commentMutation.error
                ? commentMutation.error.message
                : null
            }
          />
        )
      }
      return null
    },
    [resolveMutation, commentMutation],
  )

  // Gutter-utility click (start a comment). Routed through a ref so the
  // CodeView options object can stay stable across renders.
  const gutterClickRef = useRef<
    (range: SelectedLineRange, item: CodeViewItem<AnnotationMeta>) => void
  >(() => {})
  gutterClickRef.current = (range, item) => {
    if (!commentsEnabled || range.side !== 'additions') return
    // Block nesting: disallow starting a comment inside an existing review block.
    const insideReview = (item.annotations ?? []).some(
      (a) =>
        a.metadata?.type === 'review' &&
        range.start >= a.metadata.startLine &&
        range.start <= a.metadata.endLine,
    )
    if (insideReview) return
    commentMutation.reset()
    setComposing({ file: item.id, line: range.start })
  }

  const options = useMemo<CodeViewOptions<AnnotationMeta>>(
    () => ({
      theme: 'github-dark-default',
      diffStyle,
      diffIndicators: 'none',
      hunkSeparators: 'line-info-basic',
      overflow: 'wrap',
      // NOTE: do not set disableFileHeader. The custom header (renderCustomHeader)
      // is portaled into a <slot name="custom-header-slot"> that the library only
      // emits inside its header region — and disableFileHeader removes that region
      // entirely, so the slot never exists and the portal has nowhere to land.
      stickyHeaders: true,
      enableGutterUtility: commentsEnabled,
      unsafeCSS: REVIEW_CSS,
      onGutterUtilityClick: (range, context) => gutterClickRef.current(range, context.item),
      // Re-tag review-comment lines whenever an item (re)renders. Runs per item
      // and re-derives tags from scratch, so pooled/recycled elements never keep
      // stale highlights from a previously-rendered file.
      onPostRender: (node, _instance, phase, context) => {
        if (phase === 'unmount') return
        tagReviewLines(node, reviewRanges(context.item.annotations))
      },
    }),
    [diffStyle, commentsEnabled],
  )

  // Keyboard shortcuts. NOTE: per-line/file cursor navigation (j/k/n/p/c and the
  // focused-file v/e shortcuts) is temporarily disabled during the CodeView
  // migration; it will be rebuilt on CodeView's selection/scroll APIs. Global
  // shortcuts that don't need a focused file/line still work.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
        return
      if (e.ctrlKey || e.metaKey || e.altKey) return

      switch (e.key) {
        case '?':
          e.preventDefault()
          setShowHelp((v) => !v)
          break
        case 'Escape':
          if (showHelp) {
            e.preventDefault()
            setShowHelp(false)
          } else if (composing) {
            e.preventDefault()
            setComposing(null)
          }
          break
        case 's': {
          if (showHelp || composing) break
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
        case 'E': {
          if (showHelp || composing) break
          e.preventDefault()
          // If any file is expanded, collapse all; otherwise expand all
          const anyExpanded = files.some((f) => !(collapsed[f.name] ?? false))
          setCollapsed(Object.fromEntries(files.map((f) => [f.name, anyExpanded])))
          break
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showHelp, composing, files, collapsed, showToast])

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
        <CodeView
          ref={codeViewRef}
          className="codeview-root"
          items={items}
          options={options}
          renderCustomHeader={renderCustomHeader}
          renderAnnotation={renderAnnotation}
        />
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
