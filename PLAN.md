# local-review

Local diff review UI. Run a command, get a browser-based review interface for a
jj diff. Inline comments, file collapse, mark-as-viewed. Reviews persist in
`.local-review/` (gitignored).

## Usage

```
local-review                # review current revision (jj diff of @)
local-review <revset>       # review a specific revset
local-review -r 'trunk()..@' # review range
```

Opens a browser tab with the diff. Server stays alive until killed.

## Stack

- **Runtime:** Bun
- **Diff rendering:** `@pierre/diffs` (React components with Shiki highlighting)
- **Frontend:** React (minimal, no framework — just Bun's built-in bundling or vite)
- **Server:** Bun's built-in HTTP server (`Bun.serve`)
- **Data flow:** Server shells out to `jj diff` to get unified diff, serves it
  to the frontend via a JSON API

## Architecture

```
cli.ts              — entry point, parse args, start server, open browser
server.ts           — Bun.serve: static files + API routes + WebSocket
diff.ts             — shell out to jj, parse/structure diff data
watcher.ts          — watch working copy files, debounce, trigger re-diff
review-store.ts     — read/write review state to .local-review/

src/
  App.tsx           — top-level React component, WebSocket connection
  DiffView.tsx      — renders multi-file diff using @pierre/diffs
  Comments.tsx      — inline comment UI (add/edit/delete)
  FileList.tsx      — sidebar or header file list with viewed state
```

## Data model

Review state lives in `.local-review/reviews/<review-id>/`:

```
.local-review/reviews/<review-id>/
  review.json            — metadata + file state
  comments/
    <uuid>.md            — one file per comment
```

`review.json`:
```jsonc
{
  "id": "uuid",
  "revset": "xyz",
  "createdAt": "...",
  "files": {
    "path/to/file.ts": {
      "viewed": false,
      "collapsed": false
    }
  }
}
```

Comment files (`comments/<uuid>.md`):
```markdown
---
file: path/to/file.ts
line: 42
side: new
createdAt: 2026-03-31T...
---

why is this here?
```

Individual markdown files make comments easy to read for agents and humans
alike. The frontmatter anchors the comment to a file and line.

**Review identity:** Resolve the revset to change IDs via
`jj log -r '<revset>' --no-graph -T 'change_id ++ "\n"'`, sort them,
and hash (e.g., first 12 chars of SHA-256). This is deterministic:
the same commit set always produces the same review ID regardless of
how the revset is spelled. Resuming is automatic — just compute the
hash and check if the directory exists.

This is content-addressed identity. The alternative is reference-based
(UUID + metadata with a lookup step), which would let a review survive
its commit set changing (e.g., adding a commit to a range). But that
requires scanning existing reviews and defining what "match" means.
Not worth the complexity for v1; the content-addressed approach is
simple and the orphan case (range gained/lost a commit) is uncommon.

## API routes

```
GET  /api/diff          — returns parsed diff data (from jj)
GET  /api/review        — returns current review state
POST /api/review/file   — update file state (viewed, collapsed)
POST /api/review/comment — add/edit/delete a comment
WS   /ws                — pushes updated diffs on file change
```

## Live updating

The diff updates in the browser as you edit files. The server watches only
the specific file paths present in the current diff for write events (using
Bun's `fs.watch`, filtering to writes only). On change, debounce (~500ms),
re-run `jj diff`, and push the new diff over a WebSocket. After each
re-diff, update the watch list to match the new set of files (files may
appear or disappear from the diff).

Frontend reconciliation on update:
- Preserve scroll position
- Preserve viewed/collapsed state per file
- If a viewed file changed, mark it "changed since viewed" (visual indicator)
- Comments stay attached by file + line; no clever re-anchoring for v1

**Staleness guard:** If the update looks like a different revision entirely
(majority of files appeared/disappeared), show a banner ("diff changed
significantly — reload?") instead of silently replacing everything.

## Plan of attack

### Phase 1: Minimal viable diff viewer
1. Set up the project: `bun init`, install `@pierre/diffs`, `react`, `react-dom`
2. `cli.ts` — parse argv for optional revset, default to `@`
3. `diff.ts` — run `jj diff -r <revset> --git` to get unified diff output
4. `server.ts` — serve the diff as JSON on `/api/diff`, serve static frontend
5. `DiffView.tsx` — use `parsePatchFiles` + `MultiFileDiff` from `@pierre/diffs`
   to render the diff in the browser
6. Build step: Vite + React (plain SPA, `bun create vite --template react-ts`)
7. Open browser automatically on server start

### Phase 2: Live updating
1. `watcher.ts` — watch files in the diff, debounce, re-run `jj diff`
2. WebSocket endpoint on server, push new diff data to connected clients
3. Frontend: connect to WS, reconcile new diff with existing UI state
4. Staleness guard for dramatic changes

### Phase 3: Review state
1. `review-store.ts` — CRUD for review state + markdown comment files
2. File viewed/collapsed state — toggle in UI, persist via API
3. "Changed since viewed" indicator when live update touches a viewed file
4. File list header showing viewed progress (3/12 files viewed)

### Phase 4: Inline comments
1. Click a line to open a comment input
2. Comments render inline below the line they're attached to
3. Edit and delete existing comments
4. Comments persist as individual markdown files

### Phase 5: Polish
- Keyboard shortcuts (j/k navigate files, v mark viewed, c comment)
- Sticky file headers
- Reorder files (drag or manual sort)
- Better review identity (show change description, author)

## Open questions

- **Revset identity:** Resolved — hash of sorted change IDs. See data model
  section for rationale.
