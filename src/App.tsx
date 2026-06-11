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
  useLayoutEffect,
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
  if (!sr) return
  const pre = sr.querySelector('pre')
  if (!pre) return

  for (const el of sr.querySelectorAll('[data-review-comment]')) {
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
  focused,
  onToggleCollapse,
  onToggleViewed,
}: {
  fileDiff: FileDiffMetadata
  isViewed: boolean
  isStale: boolean
  collapsed: boolean
  focused: boolean
  onToggleCollapse: () => void
  onToggleViewed: () => void
}) {
  const { additions, deletions } = getFileStats(fileDiff)
  return (
    <div className={'file-header' + (focused ? ' focused' : '')} onClick={onToggleCollapse}>
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

/** The file pinned to the top of the viewport: the last item whose top edge is
 *  at or above the scroll offset (4px slop so a header sitting flush still
 *  counts). Returns null only when there are no items. */
function topFileName(
  inst: { getTopForItem(id: string): number | undefined },
  scrollTop: number,
  items: readonly CodeViewDiffItem<AnnotationMeta>[],
): string | null {
  let name = items[0]?.id ?? null
  for (const item of items) {
    const top = inst.getTopForItem(item.id)
    if (top == null) continue
    if (top <= scrollTop + 4) name = item.id
    else break
  }
  return name
}

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

  // Navigable lines per file for the j/k cursor: addition-side line numbers
  // (context + additions; deletions are skipped), derived from hunk metadata
  // rather than the DOM.
  const fileLines = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const f of files) {
      const lines: number[] = []
      for (const h of f.hunks) {
        for (let i = 0; i < h.additionCount; i++) lines.push(h.additionStart + i)
      }
      map.set(f.name, lines)
    }
    return map
  }, [files])

  // j/k line cursor: a (file, line) position on the additions side. Rendered
  // through CodeView's native line selection (see effect below) so cursor
  // moves don't bump item versions. Ref-mirrored for the key handler.
  const [cursor, setCursor] = useState<{ file: string; line: number } | null>(null)
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

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
  // Latest scroll offset, tracked for file navigation (n/p). Kept in a ref so
  // scrolling doesn't trigger re-renders; the key handler reads it on demand.
  const scrollTopRef = useRef(0)

  // The focused file: the target of the file-scoped shortcuts (n/p, j/k, e, v)
  // and the header highlight. Stepped directly by n/p — on an all-collapsed
  // diff the scroll may not move at all, so focus can't be derived from scroll
  // position alone — and re-synced to the top-of-viewport file when the user
  // scrolls. A ref mirrors the state so the window-level key handler reads the
  // live value without re-subscribing on every scroll.
  const [focusedFile, setFocusedFile] = useState<string | null>(null)
  const focusedFileRef = useRef<string | null>(null)
  const setFocused = useCallback((name: string | null) => {
    focusedFileRef.current = name
    setFocusedFile(name)
  }, [])

  // Programmatic scrolls (n/p, j/k, collapse re-anchoring) must not re-derive
  // focus from intermediate scroll positions — n/p already set it. Mark before
  // issuing a scrollTo; onScroll skips focus sync while marked, and the mark
  // expires shortly after scrolling settles (or immediately if no scroll
  // event ever fires) so user scrolls sync focus again.
  const programmaticScrollRef = useRef(false)
  const scrollSettleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true
    clearTimeout(scrollSettleTimer.current)
    scrollSettleTimer.current = setTimeout(() => {
      programmaticScrollRef.current = false
    }, 200)
  }, [])

  // Mirror items in a ref so onScroll can stay identity-stable.
  const itemsRef = useRef<readonly CodeViewDiffItem<AnnotationMeta>[]>([])
  const onScroll = useCallback(
    (scrollTop: number, viewer: { getTopForItem(id: string): number | undefined }) => {
      scrollTopRef.current = scrollTop
      if (programmaticScrollRef.current) {
        markProgrammaticScroll() // push the expiry out while frames keep coming
        return
      }
      setFocused(topFileName(viewer, scrollTop, itemsRef.current))
    },
    [setFocused, markProgrammaticScroll],
  )

  // Build the CodeView item list. CodeView only re-renders an item when its
  // `version` changes, so we bump version whenever any rendered input for a
  // file changes: its content hash (which also covers review annotations,
  // since those are derived from diff content), the composing-form line, or
  // its collapsed state. diffStyle is deliberately not in the key: an
  // `options` change makes the library re-render every item on its own.
  //
  // The map is mutated during render, which is safe here: writes are
  // idempotent per key and versions only increase, so a StrictMode double
  // render or a discarded concurrent render can't produce an inconsistent
  // version for a given key.
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
  itemsRef.current = items

  // The header highlight falls back to the first file before any focus exists
  // or when the focused file is no longer in the diff (e.g. removed by a
  // refetch) — matching currentIndex()'s fallback so the highlight always
  // agrees with the file the shortcuts act on.
  const effectiveFocused =
    focusedFile != null && items.some((it) => it.id === focusedFile)
      ? focusedFile
      : (items[0]?.id ?? null)

  // CodeView's controlled setItems path doesn't scroll-anchor across layout
  // changes, so collapsing the file pinned to the top of the viewport leaves
  // scrollTop pointing at whatever content slid up into its place. Before
  // toggling collapse on a file whose top is at or above the viewport top,
  // record it here; after the items rebuild, re-anchor its header to the top.
  const pendingAnchorRef = useRef<string | null>(null)
  const anchorIfTopFile = useCallback((name: string) => {
    const top = codeViewRef.current?.getInstance()?.getTopForItem(name)
    if (top != null && top <= scrollTopRef.current + 4) {
      pendingAnchorRef.current = name
    }
  }, [])

  useLayoutEffect(() => {
    const name = pendingAnchorRef.current
    if (!name) return
    pendingAnchorRef.current = null
    markProgrammaticScroll()
    codeViewRef.current?.scrollTo({
      type: 'item',
      id: name,
      align: 'start',
      behavior: 'instant',
    })
  }, [items, markProgrammaticScroll])

  // Render the cursor through CodeView's native line selection. Re-applied on
  // items changes too because a version bump re-renders the item's element,
  // which would otherwise drop the selection styling.
  useEffect(() => {
    const inst = codeViewRef.current?.getInstance()
    if (!inst) return
    if (cursor) {
      inst.setSelectedLines({
        id: cursor.file,
        range: { start: cursor.line, end: cursor.line, side: 'additions' },
      })
    } else {
      inst.clearSelectedLines()
    }
  }, [cursor, items])

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
          focused={name === effectiveFocused}
          onToggleCollapse={() => {
            anchorIfTopFile(name)
            setCollapsed((prev) => ({ ...prev, [name]: !isCollapsed }))
          }}
          onToggleViewed={() => {
            if (!hash) return
            const mark = !isViewed
            anchorIfTopFile(name)
            setCollapsed((prev) => ({ ...prev, [name]: mark }))
            markMutation.mutate({ file: name, hash, mark })
          }}
        />
      )
    },
    [data, viewed, collapsed, markMutation, anchorIfTopFile, effectiveFocused],
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
      // The library lays out collapsed files (and unmeasured estimates) from
      // these metrics rather than the DOM. Its diffHeaderHeight default (44)
      // is for its own header; ours renders at 40px (.file-header: 28px
      // controls + 2*5px padding + 2*1px borders). With the wrong value,
      // computed scroll height overshoots actual content by 4px per collapsed
      // file, and the sticky container's bottom-clamp turns that into a
      // visible downward shift of all content whenever the diff fits the
      // viewport (e.g. everything collapsed) — content then "jumps" on any
      // fits/overflows transition.
      itemMetrics: { diffHeaderHeight: 40 },
      diffIndicators: 'classic',
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
      onPostRender: (node, instance, phase, context) => {
        if (phase === 'unmount') return
        tagReviewLines(node, reviewRanges(context.item.annotations))
        // Re-apply the cursor selection: a re-rendered (version-bumped) or
        // pooled element loses its selection styling, and the library's own
        // re-sync short-circuits when the range is unchanged — so force it by
        // clearing first.
        const cur = cursorRef.current
        if (cur?.file === context.item.id) {
          instance.setSelectedLines(null, { notify: false })
          instance.setSelectedLines(
            { start: cur.line, end: cur.line, side: 'additions' },
            { notify: false },
          )
        }
      },
    }),
    [diffStyle, commentsEnabled],
  )

  // Keyboard shortcuts. File navigation (n/p) and the focused-file actions
  // (e/v) operate on the focused file (header highlight); the j/k line cursor
  // moves within it and c comments on the cursor line.
  useEffect(() => {
    // Index of the focused file (0 before any focus exists, matching the
    // effectiveFocused fallback).
    function currentIndex(): number {
      const idx = items.findIndex((it) => it.id === focusedFileRef.current)
      return idx < 0 ? 0 : idx
    }

    // Per-item virtualized instance, only available while the item is rendered.
    function renderedInstance(id: string) {
      const inst = codeViewRef.current?.getInstance()
      const rendered = inst?.getRenderedItems().find((r) => r.id === id)
      return rendered?.type === 'diff' ? rendered.instance : undefined
    }

    // Height of the sticky file header, which occludes the top of the viewport.
    function headerHeight(): number {
      return document.querySelector('.file-header')?.getBoundingClientRect().height ?? 0
    }

    // Is the line fully visible (below the sticky header, above the bottom)?
    function isLineVisible(file: string, line: number): boolean {
      const inst = codeViewRef.current?.getInstance()
      const itemTop = inst?.getTopForItem(file)
      const pos = renderedInstance(file)?.getLinePosition(line, 'additions')
      if (inst == null || itemTop == null || pos == null) return false
      const absTop = itemTop + pos.top
      const st = scrollTopRef.current
      return absTop >= st + headerHeight() && absTop + pos.height <= st + inst.getHeight()
    }

    // First navigable line of `file` at or below the viewport top, or null.
    function firstVisibleLine(file: string): number | null {
      const lines = fileLines.get(file)
      const inst = codeViewRef.current?.getInstance()
      const itemTop = inst?.getTopForItem(file)
      const ri = renderedInstance(file)
      if (!lines?.length || inst == null || itemTop == null || ri == null) return null
      const viewTop = scrollTopRef.current + headerHeight() - itemTop
      // Lines are in layout order: binary search for the first one below viewTop.
      let lo = 0
      let hi = lines.length - 1
      let ans = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const pos = ri.getLinePosition(lines[mid]!, 'additions')
        if (pos == null) return null
        if (pos.top >= viewTop) {
          ans = mid
          hi = mid - 1
        } else {
          lo = mid + 1
        }
      }
      return ans >= 0 ? lines[ans]! : null
    }

    function handler(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
        return
      if (e.ctrlKey || e.metaKey || e.altKey) return

      switch (e.key) {
        case 'n':
        case 'p': {
          if (showHelp || composing || items.length === 0) break
          e.preventDefault()
          const inst = codeViewRef.current?.getInstance()
          if (!inst) break
          const cur = currentIndex()
          let target: number
          if (e.key === 'n') {
            if (cur === items.length - 1) break // already at the last file
            target = cur + 1
          } else {
            const curTop = inst.getTopForItem(items[cur]!.id) ?? 0
            // If scrolled into the body of the current file, snap to its top
            // first; otherwise step to the previous file.
            target = scrollTopRef.current > curTop + 4 ? cur : Math.max(cur - 1, 0)
          }
          const targetId = items[target]!.id
          // Move focus immediately rather than waiting for the scroll-driven
          // sync, which may never fire (all-collapsed diffs don't scroll).
          setFocused(targetId)
          markProgrammaticScroll()
          codeViewRef.current?.scrollTo({ type: 'item', id: targetId, align: 'start' })
          const lines = fileLines.get(targetId)
          setCursor(lines?.length ? { file: targetId, line: lines[0]! } : null)
          break
        }
        case 'j':
        case 'k': {
          if (showHelp || composing || items.length === 0) break
          e.preventDefault()
          const name = items[currentIndex()]!.id
          if (collapsed[name] ?? false) break
          const lines = fileLines.get(name)
          if (!lines?.length) break
          const cur = cursorRef.current
          let nextLine: number
          if (cur && cur.file === name && isLineVisible(name, cur.line)) {
            const idx = lines.indexOf(cur.line)
            const moved = Math.max(
              0,
              Math.min(idx + (e.key === 'j' ? 1 : -1), lines.length - 1),
            )
            nextLine = lines[moved]!
          } else {
            // Cursor offscreen or in another file: snap to the first visible
            // line instead of moving.
            nextLine = firstVisibleLine(name) ?? lines[0]!
          }
          if (cur?.file === name && cur.line === nextLine) break
          setCursor({ file: name, line: nextLine })
          markProgrammaticScroll()
          codeViewRef.current?.scrollTo({
            type: 'line',
            id: name,
            lineNumber: nextLine,
            side: 'additions',
            align: 'nearest',
            behavior: 'instant',
          })
          break
        }
        case 'c': {
          if (!commentsEnabled || showHelp || composing) break
          e.preventDefault()
          const cur = cursorRef.current
          if (!cur || (collapsed[cur.file] ?? false)) break
          // Same guard as gutter clicks: no comments inside an existing review block.
          const item = items.find((i) => i.id === cur.file)
          const insideReview = (item?.annotations ?? []).some(
            (a) =>
              a.metadata?.type === 'review' &&
              cur.line >= a.metadata.startLine &&
              cur.line <= a.metadata.endLine,
          )
          if (insideReview) break
          commentMutation.reset()
          setComposing({ file: cur.file, line: cur.line })
          break
        }
        case 'e': {
          if (showHelp || composing || items.length === 0) break
          e.preventDefault()
          const name = items[currentIndex()]!.id
          anchorIfTopFile(name)
          setCollapsed((prev) => ({ ...prev, [name]: !(prev[name] ?? false) }))
          break
        }
        case 'v': {
          if (showHelp || composing || items.length === 0) break
          e.preventDefault()
          const name = items[currentIndex()]!.id
          const hash = data?.fileHashes[name]
          if (!hash) break
          const mark = viewed[name] !== hash
          anchorIfTopFile(name)
          setCollapsed((prev) => ({ ...prev, [name]: mark }))
          markMutation.mutate({ file: name, hash, mark })
          break
        }
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
          if (items.length > 0) anchorIfTopFile(items[currentIndex()]!.id)
          setCollapsed(Object.fromEntries(files.map((f) => [f.name, anyExpanded])))
          break
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    showHelp,
    composing,
    files,
    collapsed,
    showToast,
    items,
    data,
    viewed,
    markMutation,
    anchorIfTopFile,
    fileLines,
    commentsEnabled,
    commentMutation,
    setFocused,
    markProgrammaticScroll,
  ])

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
          onScroll={onScroll}
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
