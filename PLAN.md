# local-review

Local diff review UI. Run a command, get a browser-based review interface
for a jj diff. File collapse, mark-as-viewed, keyboard navigation.

Two kinds of persistent state, stored in ways that match their nature:

- **Comments** — `// REVIEW:` comments in the source code, versioned by jj
- **Viewed state** — content-hashed file map in `~/.local/share/local-review/`

Everything else is ephemeral UI state.

## Usage

```
local-review                    # review trunk()..@ (default)
local-review -r 'trunk()..@'   # review a revset (-r/--revisions)
local-review -f main -t @      # review from/to specific revisions
local-review --dev              # run with Vite dev server (HMR for tool development)
```

Opens a browser tab with the diff. Server stays alive until killed.

CLI argument parsing via commander.js.

## Why web, not TUI

A TUI covers other terminal panes — the original problem with delta. A web
UI lives in a separate browser window alongside the terminal. This matters
more when reviewing agent-generated diffs, which tend to be large and benefit
from richer rendering (Shiki syntax highlighting, flexible layout).

## Stack

- **Runtime:** Bun
- **Diff rendering:** `@pierre/diffs` (React components with Shiki highlighting, docs in `/tmp/diffs-docs.txt`)
- **Frontend:** React SPA (Vite + React)
- **Server:** Bun's built-in HTTP server (`Bun.serve`)
- **Data flow:** Server shells out to `jj diff` to get unified diff, serves it
  to the frontend via JSON API + WebSocket for live updates

## Architecture

By default, a single Bun server handles API routes and serves the Vite
build output from `dist/`. With `--dev`, it instead spawns a Vite dev
server (HMR) alongside the API server for tool development.

```
cli.ts              — entry point, parse args (commander.js), start server, open browser
server/
  main.ts           — Bun.serve: static files + API routes + WebSocket
  diff.ts           — shell out to jj, parse/structure diff data
  viewed.ts         — content-hashed viewed state, persisted to disk
  comment.ts        — insert/remove REVIEW comments in source files
  watcher.ts        — watch working copy files, debounce, trigger re-diff

src/
  App.tsx           — top-level React component, WebSocket connection
```

## Comments

Comments live in the source code as `// REVIEW:` comments (or `# REVIEW:`
etc. depending on language). No separate storage, no anchoring problem —
they move with the code because they _are_ the code.

Adding a comment through the UI opens a text input on that line (like
GitHub's comment box). On submit, it inserts a `// REVIEW:` line into
the source file. The watcher picks up the change and the diff updates.
Deleting a comment removes the line.

`// REVIEW:` lines in the diff should be visually distinct (different
background, callout style, etc.) but remain in the normal diff flow
rather than being pulled out as overlays. Exact styling TBD based on
what `@pierre/diffs` customization hooks allow.

The workflow: review the diff, leave `// REVIEW:` comments on things to
fix, go fix them, delete the comment as you address it. Agents can read
review comments directly in the source. Comments that survive to the PR
are just TODOs — not a problem.

## Viewed state

Content-addressed. When you mark a file as viewed, store a hash of its
diff hunk content. To check status, hash the current diff hunk and look
it up:

- Hash matches → viewed
- Hash absent → unreviewed
- Hash present but doesn't match current → changed since viewed (automatic)

No explicit invalidation logic — staleness falls out of the data model.
Self-validating regardless of rebases, time passing, or session restarts.

Persists to disk in `~/.local/share/local-review/<repo-hash>/viewed.json`
(map of file paths to content hashes). One file per repo, no session key
— the content hash is self-validating, so the store doesn't need to be
scoped to a particular revset.

## API

```
GET  /api/diff              — returns parsed diff data (from jj)
GET  /api/file-contents     — returns old + new contents for a single file
POST /api/comment           — write a REVIEW comment to a source file at a given line
DELETE /api/comment         — remove a REVIEW comment from a source file
```

## Live updating

Client polls via react-query `refetchInterval` (~2–3s). Frontend
reconciliation on update:

- Preserve scroll position
- Preserve viewed/collapsed state
- If a viewed file changed, mark it "changed since viewed"

**Staleness guard:** If the update looks like a different revision
entirely (majority of files appeared/disappeared), show a banner instead
of silently replacing everything.

## Plan of attack

### Phase 1: Minimal diff viewer ✓

1. Set up project: `bun init`, Vite + React, install `@pierre/diffs`
2. `cli.ts` — parse argv for optional revset, default to `@`
3. `diff.ts` — run `jj diff -r <revset> --git` to get unified diff
4. `server.ts` — serve diff as JSON, serve static frontend
5. `DiffView.tsx` — `parsePatchFiles` + `FileDiff` from `@pierre/diffs`
6. Open browser on server start

### Phase 2: Live updating

1. Poll from the client via react-query `refetchInterval` (~2–3s)
2. Staleness guard: if the update looks like a different revision
   entirely (majority of files appeared/disappeared), show a banner

### Phase 3: File state ✓

1. Content-hashed viewed toggle per file
2. "Changed since viewed" indicator
3. Progress bar (3/12 files viewed)
4. Persist to `~/.local/share/local-review/`

### Phase 4: Review comments ✓

1. Click a line to add a `// REVIEW:` comment — UI writes to source file
2. Display existing REVIEW comments with distinct styling in the diff
3. Delete comment through UI (removes line from source file)

### Phase 5: CLI and server ✓

1. CLI argument parsing with commander.js (`-r`, `-C`, `--dev`, `--help`)
2. Single-server production mode: Bun serves `dist/` + API on one port
3. `--dev` mode: spawn Vite dev server alongside API server (current behavior)
4. Drop session key from viewed state (content hash is sufficient)

### Phase 6: Context expansion

Initial load uses `parsePatchFiles` with default context (~3 lines).
When the user clicks to expand context around a hunk, the client
requests a re-diff of just that file with more context:

```
GET /api/diff?file=<path>&context=100
```

Server runs `jj diff -r <revset> --git --context=N <file>`, returns
the single-file patch. Client re-parses it and replaces that file's
`FileDiffMetadata`. Stays entirely in the patch-parsing path — no new
data model, no full file contents, Shiki only highlights lines in the
patch. If the user keeps expanding, re-fetch with a larger N.

For "show entire file" (if ever needed), fall back to
`GET /api/file-contents?file=<path>` + `parseDiffFromFile`. This
enables `@pierre/diffs`' built-in expansion (`expandUnchanged`,
`expansionLineCount`). **Needs validation first:** test with a large
file to check if diff computation and highlighting are lazy or eager.

### Phase 7: File navigation

- File tree sidebar and/or filter-by-name for diffs with many files
- Test performance on large diffs (e.g. big rebases, vendor updates)

### Phase 8: Polish

- Better context display (change description, author)
- Keyboard shortcuts:
  - `n`/`p` — jump between files
  - `j`/`k` — scroll line-by-line within current file
  - `v` — toggle viewed on focused file
  - `e` — toggle collapse on focused file
  - `s` — toggle split/unified diff
  - `c` — add comment on focused line
