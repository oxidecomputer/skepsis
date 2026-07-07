/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { z } from 'zod'
import type { CommentSyntax } from './reviewComments.ts'

// --- Request schemas (validated by server) ---

export const viewedRequestSchema = z.object({
  file: z.string(),
  hash: z.string(),
})

export const viewedDeleteSchema = z.object({
  file: z.string(),
  hash: z.string(),
})

export const viewedDeleteAllSchema = z.object({
  files: z.array(viewedDeleteSchema),
})

export const commentRequestSchema = z.object({
  file: z.string(),
  afterLine: z.number(),
  text: z.string(),
})

export const commentDeleteSchema = z.object({
  file: z.string(),
  line: z.number(),
})

export const fileContentsQuerySchema = z.object({
  path: z.string(),
  // Present for renamed files: the path to fetch the old-side content from.
  oldPath: z.string().optional(),
})

// --- Request types (inferred from schemas) ---

export type ViewedRequest = z.infer<typeof viewedRequestSchema>
export type CommentRequest = z.infer<typeof commentRequestSchema>
export type CommentDeleteRequest = z.infer<typeof commentDeleteSchema>

// --- VCS types ---

/**
 * Concrete revisions at the two ends of the diff, used to fetch full file
 * contents for hunk expansion. `null` when the diff args can't be resolved to
 * concrete endpoints (exotic revsets) — expansion is disabled in that case.
 * The right side is `'workingCopy'` when the diff ends at the working tree
 * (git only; in jj the working copy is the real revision `@`).
 */
export type DiffEndpoints = {
  left: string
  right: { rev: string } | 'workingCopy'
} | null

export type DiffArgs = ({ vcs: 'jj'; args: string[] } | { vcs: 'git'; args: string[] }) & {
  commentsEnabled: boolean
  files: string[]
  endpoints: DiffEndpoints
  /** Args to show in the UI/log command string in place of `args`, for when
   *  the executed args (e.g., a resolved sha) are less readable than the
   *  user-facing form. */
  displayArgs?: string[]
}

// --- Response types (checked via satisfies on the server) ---

export type ViewedMap = Record<string, string>
export type FileHashes = Record<string, string>

export interface DiffResponse {
  patch: string
  revset: string
  vcs: 'jj' | 'git'
  commentsEnabled: boolean
  /** Whether diff endpoints resolved, so /api/file-contents can serve full
   *  file contents for hunk expansion. */
  expandable: boolean
  fileHashes: FileHashes
  viewed: ViewedMap
  /** Per-file comment syntax, shown in the comment form. An empty prefix
   *  means the format has no comment syntax (e.g. plain text); null means the
   *  file type wasn't recognized. Both get bare review tags on insert. Always
   *  empty when comments are disabled. */
  commentSyntaxes: Record<string, CommentSyntax | null>
  error?: string
}

/** Full file contents at each diff endpoint. A side is `null` when the file
 *  does not exist there (added → old null; deleted → new null) or could not be
 *  read (treated as non-expandable by the client). */
export interface FileContentsResponse {
  oldContents: string | null
  newContents: string | null
}

export interface ErrorResponse {
  error: string
}

export interface OkResponse {
  ok: true
}
