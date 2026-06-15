# skepsis

Local diff review UI: a CLI starts an HTTP server that serves a web app for
reviewing a jj/git diff in the browser, GitHub-PR-style (per-file viewed
state, keyboard navigation, review comments written into the working copy as
comment lines).

After changes, run `npm run tsc` (type-check), `npm run lint` (oxlint), and
`npm run fmt` (oxfmt) — not prettier/eslint. To try the app against a
real repo, run `node cli.ts --dev` in that repo (`--host 127.0.0.1`
suppresses auto-opening a browser).

## dist/ is committed on purpose

`dist/` (the built frontend) is versioned so people on illumos can run the
tool without building the frontend, which doesn't work on illumos. Rebuilt
`dist/` churn in a commit is legitimate content, not noise.

## Code map

```
cli.ts                CLI entry (commander). Detects jj/git, builds DiffArgs
                      (incl. commentsEnabled: diff must end at @/working copy),
                      starts the API server, spawns Vite in --dev mode.
server/
  main.ts             Hono server. GET /api/diff; POST/DELETE /api/viewed;
                      POST/DELETE /api/comment; serves dist/ statics.
  diff.ts             Runs `jj diff --git`/`git diff`, extracts per-file blob
                      hashes from index lines.
  viewed.ts           Viewed state, content-addressed by git blob ID — files
                      auto-unview when content changes; no invalidation logic.
                      TSV per repo in ~/.local/share/skepsis/.
  comment.ts          Inserts/removes <review>…</review> comment lines into
                      real working-copy files (this is how review comments
                      exist in the diff at all).
  commentSyntax.ts    Comment syntax (prefix/suffix) by file extension.
shared/
  types.ts            API request/response types + zod schemas.
  reviewComments.ts   <review> open/close tag constants and regexes shared by
                      server insertion and client detection.
src/
  App.tsx             Entire frontend (single file). Renders the diff with
                      @pierre/diffs CodeView (virtualized, shadow-DOM items);
                      react-query for API state.
  styles.css          All styling. OKLCH color tokens with a documented
                      elevation ramp at the top — extend it, don't add ad hoc
                      colors.
```

Review comments only work when the diff ends at the working copy (`-f`
without `-t`), because they're inserted as real lines into files on disk —
testing comment submit against a real repo writes `<review>` lines into its
files.
