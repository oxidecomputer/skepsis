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
  useQueries,
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
import type { ReactElement } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import { parsePatchFiles, parseDiffFromFile } from '@pierre/diffs'
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
import { THEME_MODES } from '../shared/types.ts'
import type {
  DiffResponse,
  ErrorResponse,
  FileContentsResponse,
  ThemeMode,
  ThemeResponse,
  ViewedMap,
  FileHashes,
} from '../shared/types.ts'
import {
  BARE_REVIEW_CLOSE_PATTERN,
  BARE_REVIEW_OPEN_PATTERN,
  type CommentSyntax,
  REVIEW_CLOSE_PATTERN,
  REVIEW_OPEN_PATTERN,
} from '../shared/reviewComments.ts'

const queryClient = new QueryClient()

// The /api/theme.js boot script in index.html stamps the stored theme
// preference onto <html> as data-theme before this bundle loads, so CSS pins
// color-scheme (and our light-dark() tokens resolve to the forced side)
// before first paint. Read it back as the initial client state; /api/theme
// is the source of truth from then on. The diff shadow roots don't inherit
// the page's color-scheme and are pinned separately via the CodeView
// themeType option.
const themeAttr = document.documentElement.dataset['theme']
const initialTheme: ThemeMode = (THEME_MODES as readonly (string | undefined)[]).includes(
  themeAttr,
)
  ? (themeAttr as ThemeMode)
  : 'system'

function applyTheme(theme: ThemeMode) {
  if (theme === 'system') delete document.documentElement.dataset['theme']
  else document.documentElement.dataset['theme'] = theme
}

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' } as const

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

/** Walk the addition side of a diff and find <review>...</review> blocks.
 *  Bare-fallback files get bare tags on insert, so detection matches bare tag
 *  lines only in those files — in a normal file a bare tag line is real
 *  content, not a review comment. */
function detectReviewComments(
  fileDiff: FileDiffMetadata,
  fileName: string,
  bare: boolean,
): DiffLineAnnotation<AnnotationMeta>[] {
  const openPattern = bare ? BARE_REVIEW_OPEN_PATTERN : REVIEW_OPEN_PATTERN
  const closePattern = bare ? BARE_REVIEW_CLOSE_PATTERN : REVIEW_CLOSE_PATTERN
  const annotations: DiffLineAnnotation<AnnotationMeta>[] = []
  for (const hunk of fileDiff.hunks) {
    let openLine: number | null = null
    for (let i = 0; i < hunk.additionCount; i++) {
      const lineText = fileDiff.additionLines[hunk.additionLineIndex + i]
      if (!lineText) continue
      const absLine = hunk.additionStart + i
      if (openPattern.test(lineText)) {
        openLine = absLine
      } else if (closePattern.test(lineText) && openLine !== null) {
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

// In split mode the diffs library renders pure adds ('new') and pure deletes
// ('deleted') as a single full-width column. We want them laid out like every
// other file — additions on the right, an empty deletions side on the left —
// and the column-dropping is the only thing the renderer keys off the type
// (we render our own headers), so coerce it before handing files to CodeView.
// Mutates in place to keep object identity stable across renders.
function normalizeFileType(f: FileDiffMetadata): FileDiffMetadata {
  if (f.type === 'new' || f.type === 'deleted') f.type = 'change'
  return f
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

// The diffs library's expand chevron sprite (a down chevron), as a mask so we
// can paint a placeholder copy in the same color.
const EXPAND_CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.47 5.47a.75.75 0 0 1 1.06 0L8 8.94l3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06'/%3E%3C/svg%3E\")"

// Until a file's full contents load it renders as a "partial" diff (host tagged
// data-skepsis-partial in onPostRender), whose hunk separators have no expand
// control — and the library lays the "N unmodified lines" label flush in the
// gutter. When contents arrive the separator becomes expandable: a chevron
// appears and the label jumps one gutter-width to the right. To avoid that pop,
// give the partial separators the same gutter grid and a dimmed ghost chevron,
// so loading only lights the chevron up in place.
const EXPAND_PLACEHOLDER_CSS = `
  :host([data-skepsis-partial]) [data-separator]:not(:has([data-expand-button])) [data-separator-wrapper] {
    display: grid;
    grid-template-columns: var(--diffs-column-number-width) 1fr;
    align-items: center;
  }
  :host([data-skepsis-partial]) [data-separator]:not(:has([data-expand-button])) [data-separator-wrapper]::before {
    content: '';
    width: 16px;
    height: 16px;
    justify-self: center;
    background-color: var(--diffs-fg-number);
    opacity: 0.4;
    -webkit-mask: ${EXPAND_CHEVRON} center / 16px no-repeat;
    mask: ${EXPAND_CHEVRON} center / 16px no-repeat;
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
  syntax,
}: {
  onSubmit: (text: string) => void
  onCancel: () => void
  submitting: boolean
  error: string | null
  /** Comment syntax the inserted tags will use. Empty prefix: the format has
   *  no comment syntax; null: unrecognized file type. Both insert bare. */
  syntax: CommentSyntax | null
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
        <div className="comment-form-note">
          {syntax === null ? (
            <>Comment marker: none (file type not recognized)</>
          ) : syntax.prefix === '' ? (
            <>Comment marker: none (plain text)</>
          ) : (
            <>
              Comment marker:{' '}
              <code>
                {syntax.suffix ? `${syntax.prefix} ${syntax.suffix}` : syntax.prefix}
              </code>
            </>
          )}
        </div>
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

/* Tooltip for the header buttons, portaled to document.body so it paints over
   the diff bodies — a CSS ::after tooltip on the buttons is trapped one
   stacking context below them and interleaves with the code text. `children`
   is the trigger button itself (Base UI merges its hover/focus handlers onto
   it). Replaces the native `title`, whose ~1s delay felt sluggish. */
function Tip({
  text,
  closeOnClick,
  children,
}: {
  text: React.ReactNode
  closeOnClick?: boolean
  children: ReactElement
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={150} closeOnClick={closeOnClick} render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner className="tooltip-positioner" side="bottom" sideOffset={6}>
          <Tooltip.Popup className="tooltip-popup">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

// --- File header (rendered into each CodeView item's custom-header slot) ---

// GitHub-style copy/check glyphs for the filename copy button (16x16 octicons).
function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"
      />
      <path
        fill="currentColor"
        d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"
      />
    </svg>
  )
}

// Outward-pointing chevrons (the diffs library's own expand-all glyph) for the
// expand-all-lines button.
function ExpandAllIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.47 9.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06L8 12.94zM7.526 1.418a.75.75 0 0 1 1.004.052l4 4a.75.75 0 1 1-1.06 1.06L8 3.06 4.53 6.53a.75.75 0 1 1-1.06-1.06l4-4z"
      />
    </svg>
  )
}

// Sun/moon/device-desktop octicons for the theme toggle, one per mode.
function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"
      />
    </svg>
  )
}

function SystemThemeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M14.25 1c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 12h-3.727c.099 1.041.52 1.872 1.292 2.757A.752.752 0 0 1 11.25 16h-6.5a.75.75 0 0 1-.565-1.243c.772-.885 1.192-1.716 1.292-2.757H1.75A1.75 1.75 0 0 1 0 10.25v-7.5C0 1.784.784 1 1.75 1ZM1.75 2.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25ZM9.018 12H6.982a5.72 5.72 0 0 1-.765 2.5h3.566a5.72 5.72 0 0 1-.765-2.5Z"
      />
    </svg>
  )
}

function FileHeader({
  fileDiff,
  isViewed,
  isStale,
  collapsed,
  focused,
  showExpand,
  expandDisabledReason,
  expanded,
  onToggleCollapse,
  onToggleViewed,
  onToggleExpand,
}: {
  fileDiff: FileDiffMetadata
  isViewed: boolean
  isStale: boolean
  collapsed: boolean
  focused: boolean
  showExpand: boolean
  // Non-null when the expand button is shown but can't act; used as its tooltip.
  expandDisabledReason: string | null
  expanded: boolean
  onToggleCollapse: () => void
  onToggleViewed: () => void
  onToggleExpand: () => void
}) {
  const { additions, deletions } = getFileStats(fileDiff)
  const [copied, setCopied] = useState(false)
  return (
    <div className={'file-header' + (focused ? ' focused' : '')} onClick={onToggleCollapse}>
      <span className={'collapse-chevron' + (collapsed ? ' collapsed' : '')}>
        {'\u25B6'}
      </span>
      <span className="file-header-name">{fileDiff.name}</span>
      {/* closeOnClick={false} so the tooltip stays up and flips to "Copied!". */}
      <Tip text={copied ? 'Copied!' : 'Copy file name to clipboard'} closeOnClick={false}>
        <button
          type="button"
          className={'copy-name-button' + (copied ? ' copied' : '')}
          aria-label="Copy file name to clipboard"
          onClick={(e) => {
            e.stopPropagation()
            void navigator.clipboard.writeText(fileDiff.name).then(() => {
              setCopied(true)
              // Hold the check long enough that attention moves on before it
              // cross-fades back to the clipboard.
              setTimeout(() => setCopied(false), 2000)
            })
          }}
        >
          {/* Both glyphs stay mounted and cross-fade so the swap back to the
              clipboard isn't an abrupt cut. */}
          <span className="copy-icon-stack">
            <CopyIcon />
            <CheckIcon />
          </span>
        </button>
      </Tip>
      {showExpand && (
        <Tip
          text={
            expandDisabledReason ??
            (expanded ? 'Collapse expanded lines' : 'Expand all lines')
          }
        >
          <button
            type="button"
            className={
              'expand-all-button' +
              (expanded ? ' expanded' : '') +
              (expandDisabledReason ? ' disabled' : '')
            }
            aria-label={expanded ? 'Collapse expanded lines' : 'Expand all lines'}
            aria-disabled={expandDisabledReason !== null}
            onClick={(e) => {
              e.stopPropagation()
              if (expandDisabledReason) return
              onToggleExpand()
            }}
          >
            <ExpandAllIcon />
          </button>
        </Tip>
      )}
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
  command,
  fileHashes,
  viewed,
  onUnviewAll,
  theme,
  onCycleTheme,
}: {
  command: string
  fileHashes: FileHashes
  viewed: ViewedMap
  onUnviewAll: () => void
  theme: ThemeMode
  onCycleTheme: () => void
}) {
  const total = Object.keys(fileHashes).length
  const viewedCount = Object.entries(fileHashes).filter(
    ([file, hash]) => viewed[file] === hash,
  ).length

  if (total === 0) return null

  return (
    <div className="progress-bar">
      {/* title gives a native tooltip when the command is ellipsized */}
      <code className="diff-command" title={command}>
        {command}
      </code>
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${(viewedCount / total) * 100}%` }}
        />
      </div>
      <span>
        {viewedCount}/{total} files viewed
      </span>
      <Tip text="Mark all files unviewed">
        <button
          type="button"
          className={'unview-all-button' + (viewedCount === 0 ? ' disabled' : '')}
          aria-disabled={viewedCount === 0}
          onClick={() => {
            if (viewedCount > 0) onUnviewAll()
          }}
        >
          Clear
        </button>
      </Tip>
      {/* The icon and tooltip show the current mode including "system": a
          toggle that hides the system state leaves a user who forced a theme
          long ago unable to see why the app ignores their OS setting. */}
      <Tip
        text={
          <>
            Theme: {theme} <kbd>t</kbd>
          </>
        }
      >
        <button
          type="button"
          className="theme-toggle-button"
          aria-label={`Theme: ${theme}`}
          onClick={onCycleTheme}
        >
          {theme === 'system' ? (
            <SystemThemeIcon />
          ) : theme === 'light' ? (
            <SunIcon />
          ) : (
            <MoonIcon />
          )}
        </button>
      </Tip>
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
  ['t', 'Cycle theme (system / light / dark)'],
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
  // Files the user expanded via the header's expand-all-lines button: these are
  // re-parsed with whole-file context so every collapsed region is revealed.
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
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

  // Server-persisted so the preference survives the per-run ephemeral port (a
  // fresh browser origin every run, which defeats web storage) and reaches
  // other running instances. initialData comes from the data-theme attribute
  // the server stamped into the HTML; the default refetchOnWindowFocus
  // re-applies the stored value when a stale tab regains focus — the only
  // moment cross-instance staleness is observable.
  const { data: themeData } = useQuery({
    queryKey: ['theme'],
    queryFn: () => apiFetch<ThemeResponse>('/api/theme'),
    initialData: { theme: initialTheme },
  })
  const theme = themeData.theme

  const themeMutation = useMutation({
    mutationFn: (next: ThemeMode) =>
      apiFetch('/api/theme', { method: 'POST', body: { theme: next } }),
    // Write the cache up front so the toggle doesn't fight a stale entry.
    onMutate: (next) => qc.setQueryData(['theme'], { theme: next } satisfies ThemeResponse),
  })
  const mutateTheme = themeMutation.mutate

  // Shared by the header button and the t shortcut. Returns the new mode so
  // the shortcut can toast it. Reads the current mode from the query cache
  // rather than closing over `theme`: the theme switch re-renders every
  // CodeView item, so a second press during that render would otherwise see
  // a stale mode and cycle to the same place.
  const cycleTheme = useCallback(() => {
    const cur = qc.getQueryData<ThemeResponse>(['theme'])?.theme ?? 'system'
    const next = THEME_CYCLE[cur]
    mutateTheme(next)
    return next
  }, [qc, mutateTheme])

  useEffect(() => applyTheme(theme), [theme])

  const markMutation = useMutation({
    mutationFn: ({ file, hash, mark }: { file: string; hash: string; mark: boolean }) =>
      apiFetch('/api/viewed', {
        method: mark ? 'POST' : 'DELETE',
        body: { file, hash },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['diff'] }),
  })

  const unviewAllMutation = useMutation({
    mutationFn: (files: { file: string; hash: string }[]) =>
      apiFetch('/api/viewed-all', { method: 'DELETE', body: { files } }),
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

  // Memoize patch parsing so it doesn't re-run on viewed state changes. These
  // are "partial" diffs (no full-file context), used for initial paint and as
  // the fallback when full contents aren't available.
  const patch = data?.patch
  const patchFiles = useMemo(
    () =>
      patch
        ? parsePatchFiles(patch)
            .flatMap((p) => p.files)
            .map(normalizeFileType)
        : [],
    [patch],
  )

  // Hunk expansion needs "non-partial" diffs built from full file contents.
  // The diffs library can't lazily fetch context on expand — it reads revealed
  // lines straight out of the full content arrays and exposes no expansion hook
  // (confirmed through 1.3.0-beta) — so the contents must be loaded before its
  // expand controls can work. To avoid fetching files the user never looks at,
  // a file is fetched only once it enters the virtualization window (viewport +
  // buffer). onPostRender marks rendered items "seen"; seeing a new one bumps
  // state so the queries below re-evaluate `enabled` and fire.
  const seenFilesRef = useRef(new Set<string>())
  const [, bumpSeen] = useState(0)
  const markSeen = useCallback((id: string) => {
    if (seenFilesRef.current.has(id)) return
    seenFilesRef.current.add(id)
    bumpSeen((n) => n + 1)
  }, [])

  // When contents arrive the file upgrades to an expandable diff. Files with no
  // hunks (binary, pure renames) have nothing to expand, and collapsed files
  // can't show expansion, so neither is fetched.
  const expandable = data?.expandable ?? false
  const contentQueries = useQueries({
    queries: patchFiles.map((f) => {
      const hash = data?.fileHashes[f.name]
      const params = new URLSearchParams({ path: f.name })
      if (f.prevName) params.set('oldPath', f.prevName)
      return {
        queryKey: ['file-contents', f.name, hash] as const,
        queryFn: () => apiFetch<FileContentsResponse>(`/api/file-contents?${params}`),
        enabled:
          expandable &&
          f.hunks.length > 0 &&
          seenFilesRef.current.has(f.name) &&
          !(collapsed[f.name] ?? false),
        staleTime: Infinity,
      }
    }),
  })

  // Map of loaded contents by file name. contentQueries is a fresh array each
  // render, so this recomputes often, but it's just a small map build.
  const contentsByFile = useMemo(() => {
    const map = new Map<string, FileContentsResponse>()
    patchFiles.forEach((f, i) => {
      const d = contentQueries[i]?.data
      if (d) map.set(f.name, d)
    })
    return map
  }, [patchFiles, contentQueries])

  // Upgrade files whose contents have loaded to non-partial (expandable) diffs;
  // others keep their partial patch parse. parseDiffFromFile (jsdiff) is cached
  // per file+content so it doesn't re-run on unrelated renders.
  const parsedCacheRef = useRef(
    new Map<
      string,
      { old: string | null; new: string | null; expanded: boolean; diff: FileDiffMetadata }
    >(),
  )
  const files = useMemo(() => {
    return patchFiles.map((f) => {
      const c = contentsByFile.get(f.name)
      if (!c || (c.oldContents == null && c.newContents == null)) return f
      const isExpanded = expandedFiles[f.name] ?? false
      const cached = parsedCacheRef.current.get(f.name)
      if (
        cached &&
        cached.old === c.oldContents &&
        cached.new === c.newContents &&
        cached.expanded === isExpanded
      ) {
        return cached.diff
      }
      // context: 3 matches git's default so the visible context doesn't jump
      // when a file upgrades from its patch parse to the full-content diff.
      // Expand-all uses whole-file context so the entire file shows as one hunk.
      const diff = normalizeFileType(
        parseDiffFromFile(
          { name: f.prevName ?? f.name, contents: c.oldContents ?? '' },
          { name: f.name, contents: c.newContents ?? '' },
          { context: isExpanded ? Number.MAX_SAFE_INTEGER : 3 },
        ),
      )
      parsedCacheRef.current.set(f.name, {
        old: c.oldContents,
        new: c.newContents,
        expanded: isExpanded,
        diff,
      })
      return diff
    })
  }, [patchFiles, contentsByFile, expandedFiles])

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

  // Derive optimistic viewed state from pending mutations
  const viewed = useMemo(() => {
    const base = { ...data?.viewed }
    if (markMutation.isPending && markMutation.variables) {
      const { file, hash, mark } = markMutation.variables
      if (mark) base[file] = hash
      else delete base[file]
    }
    if (unviewAllMutation.isPending && unviewAllMutation.variables) {
      for (const { file } of unviewAllMutation.variables) delete base[file]
    }
    return base
  }, [
    data,
    markMutation.isPending,
    markMutation.variables,
    unviewAllMutation.isPending,
    unviewAllMutation.variables,
  ])

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
      const syntax = data.commentSyntaxes[name]
      const annotations = commentsEnabled
        ? detectReviewComments(fileDiff, name, !syntax || syntax.prefix === '')
        : []
      if (composing?.file === name) {
        annotations.push({
          side: 'additions',
          lineNumber: composing.line,
          metadata: { type: 'composing', file: name },
        })
      }
      const isCollapsed = collapsed[name] ?? false
      const isExpanded = expandedFiles[name] ?? false
      const composingLine = composing?.file === name ? composing.line : -1
      // fileDiff.isPartial flips false once full contents load, upgrading the
      // item to an expandable diff — bump the version so CodeView re-renders it.
      // isExpanded is in the key too: expand-all swaps fileDiff for a re-parse
      // at the same content hash, so nothing else here would move the version.
      const key = `${fileHashes[name] ?? ''}|${composingLine}|${isCollapsed ? 1 : 0}|${fileDiff.isPartial ? 1 : 0}|${isExpanded ? 1 : 0}`
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
  }, [files, data, composing, collapsed, expandedFiles, commentsEnabled])
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
      // Show the expand control for any text diff (files with hunks); binary /
      // pure-rename diffs have no lines to expand. When the diff range can't
      // serve full contents at all, leave it visible but disabled with a tooltip
      // explaining why, rather than letting it silently vanish. A collapsed file
      // isn't disabled: expanding it also opens it (see onToggleExpand).
      const showExpand = item.fileDiff.hunks.length > 0
      const expandDisabledReason = expandable
        ? null
        : "Line expansion isn't available for this diff range"
      return (
        <FileHeader
          fileDiff={item.fileDiff}
          isViewed={isViewed}
          isStale={isStale}
          collapsed={isCollapsed}
          focused={name === effectiveFocused}
          showExpand={showExpand}
          expandDisabledReason={expandDisabledReason}
          expanded={expandedFiles[name] ?? false}
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
          onToggleExpand={() => {
            anchorIfTopFile(name)
            const willExpand = !(expandedFiles[name] ?? false)
            setExpandedFiles((prev) => ({ ...prev, [name]: willExpand }))
            // Expanding a collapsed file also opens it — otherwise the revealed
            // lines would sit behind a hidden body.
            if (willExpand && isCollapsed) {
              setCollapsed((prev) => ({ ...prev, [name]: false }))
            }
          }}
        />
      )
    },
    [
      data,
      viewed,
      collapsed,
      expandable,
      expandedFiles,
      markMutation,
      anchorIfTopFile,
      effectiveFocused,
    ],
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
            syntax={data?.commentSyntaxes[file] ?? null}
          />
        )
      }
      return null
    },
    [resolveMutation, commentMutation, data],
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
      // Always the dual theme: Shiki tokenizes both up front and switching
      // themes is purely a CSS flip (a single theme would retokenize on every
      // toggle). themeType pins the shadow roots' color-scheme — they don't
      // inherit the page's value ('system' leaves their :host default of
      // `light dark`, following the OS).
      theme: { light: 'github-light-default', dark: 'github-dark-default' },
      themeType: theme,
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
      unsafeCSS: REVIEW_CSS + EXPAND_PLACEHOLDER_CSS,
      onGutterUtilityClick: (range, context) => gutterClickRef.current(range, context.item),
      // Re-tag review-comment lines whenever an item (re)renders. Runs per item
      // and re-derives tags from scratch, so pooled/recycled elements never keep
      // stale highlights from a previously-rendered file.
      onPostRender: (node, instance, phase, context) => {
        if (phase === 'unmount') return
        // Mark the file seen so its full contents get fetched for expansion.
        markSeen(context.item.id)
        // Tag partial (not-yet-loaded) diffs so EXPAND_PLACEHOLDER_CSS can ghost
        // an expand chevron into their separators and avoid layout pop on load.
        if (context.item.type === 'diff') {
          node.toggleAttribute('data-skepsis-partial', context.item.fileDiff.isPartial)
        }
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
    [theme, diffStyle, commentsEnabled, markSeen],
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
        case 't': {
          if (showHelp || composing) break
          e.preventDefault()
          const next = cycleTheme()
          showToast(
            <>
              Theme: <code>{next}</code>
            </>,
          )
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
    cycleTheme,
  ])

  // Error before loading: on a failed fetch react-query settles with `data`
  // undefined, so a loading-first guard would show "Loading..." forever.
  if (error) return <pre style={{ color: 'red', padding: 20 }}>{String(error)}</pre>
  if (isLoading || !data) return <div className="empty-diff">Loading...</div>
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
        <ProgressBar
          command={data.revset}
          fileHashes={fileHashes}
          viewed={viewed}
          theme={theme}
          onCycleTheme={cycleTheme}
          onUnviewAll={() => {
            const entries = Object.entries(viewed).map(([file, hash]) => ({ file, hash }))
            if (entries.length === 0) return
            // Mirror single-file unview, which also opens the file.
            setCollapsed((prev) => {
              const next = { ...prev }
              for (const { file } of entries) next[file] = false
              return next
            })
            unviewAllMutation.mutate(entries)
          }}
        />
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
      <Tooltip.Provider>
        <DiffView />
      </Tooltip.Provider>
    </QueryClientProvider>
  )
}
