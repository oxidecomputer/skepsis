# local-review

Local diff review UI. Run a command, get a browser-based review interface
for a jj diff. File collapse, mark-as-viewed, keyboard navigation.

Two kinds of persistent state, stored in ways that match their nature:

- **Comments** — `// REVIEW:` comments in the source code, versioned by jj
- **Viewed state** — content-hashed file map in `.local-review/`, gitignored

Everything else is ephemeral UI state.

## Usage

```
local-review                # review current revision (jj diff of @)
local-review <revset>       # review a specific revset
local-review -r 'trunk()..@' # review range
```

Opens a browser tab with the diff. Server stays alive until killed.

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

```
cli.ts              — entry point, parse args, start server, open browser
server.ts           — Bun.serve: static files + API routes + WebSocket
diff.ts             — shell out to jj, parse/structure diff data
watcher.ts          — watch working copy files, debounce, trigger re-diff

src/
  App.tsx           — top-level React component, WebSocket connection
  DiffView.tsx      — renders multi-file diff using @pierre/diffs
  FileList.tsx      — sidebar or header file list with viewed state
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

Persists to disk in `.local-review/viewed.json` (map of file paths to
content hashes). Gitignored. Does not need version control because the
content hash is the source of truth, not the timeline.

## API

```
GET  /api/diff          — returns parsed diff data (from jj)
POST /api/comment       — write a REVIEW comment to a source file at a given line
DELETE /api/comment     — remove a REVIEW comment from a source file
WS   /ws                — pushes updated diffs on file change
```

## Live updating

The server watches only the specific file paths present in the current
diff for write events (Bun `fs.watch`). On change, debounce (~500ms),
re-run `jj diff`, push the new diff over WebSocket. After each re-diff,
update the watch list to match the new set of files.

Frontend reconciliation on update:

- Preserve scroll position
- Preserve viewed/collapsed state
- If a viewed file changed, mark it "changed since viewed"

**Staleness guard:** If the update looks like a different revision
entirely (majority of files appeared/disappeared), show a banner instead
of silently replacing everything.

## Plan of attack

### Phase 1: Minimal diff viewer

1. Set up project: `bun init`, Vite + React, install `@pierre/diffs`
2. `cli.ts` — parse argv for optional revset, default to `@`
3. `diff.ts` — run `jj diff -r <revset> --git` to get unified diff
4. `server.ts` — serve diff as JSON, serve static frontend
5. `DiffView.tsx` — `parsePatchFiles` + `MultiFileDiff` from `@pierre/diffs`
6. Open browser on server start

### Phase 2: Live updating

1. `watcher.ts` — watch diff files for writes, debounce, re-diff
2. WebSocket endpoint, push new diff to connected clients
3. Frontend reconciliation (preserve scroll, viewed state)
4. Staleness guard

### Phase 3: File state

1. Content-hashed viewed toggle per file
2. "Changed since viewed" indicator
3. File list with viewed progress (3/12 files viewed)
4. Persist to `.local-review/viewed.json`

### Phase 4: Review comments

1. Click a line to add a `// REVIEW:` comment — UI writes to source file
2. Display existing REVIEW comments with distinct styling in the diff
3. Delete comment through UI (removes line from source file)

### Phase 5: Polish

- Sticky file headers
- Better context display (change description, author)
- Keyboard shortcuts:
  - `n`/`p` — jump between files
  - `j`/`k` — scroll line-by-line within current file
  - `v` — toggle viewed on focused file
  - `e` — toggle collapse on focused file
  - `s` — toggle split/unified diff
  - `c` — add comment on focused line
