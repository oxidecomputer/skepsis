import { z } from 'zod'

// --- Request schemas (validated by server) ---

export const viewedRequestSchema = z.object({
  file: z.string(),
  hash: z.string(),
})

export const viewedDeleteSchema = z.object({
  file: z.string(),
  hash: z.string(),
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

// --- Request types (inferred from schemas) ---

export type ViewedRequest = z.infer<typeof viewedRequestSchema>
export type CommentRequest = z.infer<typeof commentRequestSchema>
export type CommentDeleteRequest = z.infer<typeof commentDeleteSchema>

// --- VCS types ---

export type DiffArgs = ({ vcs: 'jj'; args: string[] } | { vcs: 'git'; args: string[] }) & {
  commentsEnabled: boolean
  files: string[]
}

// --- Response types (checked via satisfies on the server) ---

export type ViewedMap = Record<string, string>
export type FileHashes = Record<string, string>

export interface DiffResponse {
  patch: string
  revset: string
  vcs: 'jj' | 'git'
  commentsEnabled: boolean
  fileHashes: FileHashes
  viewed: ViewedMap
  error?: string
}

export interface ErrorResponse {
  error: string
}

export interface OkResponse {
  ok: true
}
