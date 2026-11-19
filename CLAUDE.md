# skepsis

Local diff review UI: a CLI starts an HTTP server that serves a web app for
reviewing a jj/git diff in the browser, GitHub-PR-style (per-file viewed
state, keyboard navigation, review comments written into the working copy as
comment lines).

After changes, run `npm run ci` unless narrowing is clearly justified. That
runs the build, type-check, oxlint, oxfmt check, unit tests, and the Playwright
e2e tests (`npm run e2e`; needs a one-time `npx playwright install chromium firefox`).
Use `npm run fmt` to apply formatting — not prettier/eslint. To try the app
against a real repo, run `node cli.ts --dev` in that repo (`--no-open`
suppresses auto-opening a browser).

## npm package build

The npm package `@oxide/skepsis` has the CLI as its bin and a library entry
(`lib.ts`, for applications that mount the review page in their own server)
as its export. `npm run build` removes `dist/`, builds the frontend into
`dist/web`, then bundles the CLI and the library with tsdown into
`dist/cli.js`, `dist/lib.js`, and `dist/lib.d.ts`. Runtime dependencies are
bundled into both, so the published package has no production dependencies
and `npx @oxide/skepsis` does not run a build step. `lib.d.ts` must not
import anything: hono and zod are devDependencies, so their types can't
appear in the library's API.

Every package goes in `devDependencies`, never `dependencies` (use `npm install
--save-dev`). tsdown bundles whatever the CLI and library import, and vite
bundles the frontend, so a `dependencies` entry would only add an install step
to `npx`.

`dist/` is ignored build output. Do not edit it by hand or include it in
reviews; regenerate it with `npm run build` when checking package behavior.

## Layout

`cli.ts` at the repo root is the CLI's entry point and `lib.ts` the
library's. `server/` is the Hono API (`app.ts` builds it, `main.ts` serves it
for the CLI), `src/` is the frontend (`App.tsx` is all of it, plus
`styles.css`), `shared/` holds types and constants both sides import, and
`e2e/` is Playwright. Unit tests live beside their subject as `*.test.ts`.

## Things that aren't obvious from the code

- Review comments are inserted as real `<review>` lines into working-copy
  files on disk (`server/comment.ts`) — that's how they show up in the diff at
  all. They only work when the diff ends at the working copy (`-f` without
  `-t`), and testing comment submit against a real repo writes those lines
  into that repo's files.
- Viewed state is content-addressed by git blob ID, so files auto-unview when
  their content changes and there is no invalidation logic to maintain.
- Settings are global rather than per-repo (the theme is about the user, not
  the diff): `~/.local/share/skepsis/settings.json`. Viewed state is per-repo
  TSV in the same directory.
- A forced theme has to reach `<html>` before first paint, so the server
  serves it as a render-blocking script — `GET /api/theme.js`, loaded by
  `index.html`.
- The diff renders through `@pierre/diffs` CodeView: virtualized, with each
  item in its own shadow root, so page CSS and the page's `color-scheme` don't
  reach the diff. Pass theming in through CodeView options instead.
- The file tree sidebar is `@pierre/trees`, which also renders in a shadow
  root. Colors reach it through its `--trees-*-override` custom properties
  (set on `.file-tree` in `styles.css`) and anything else through the
  `unsafeCSS` option in `App.tsx`. Its open/closed state is in
  `localStorage`, not settings.json.
- Hunk expansion needs both diff endpoints to resolve to concrete revisions;
  exotic revsets leave them null and expansion is disabled.
- All styling is in `src/styles.css`: OKLCH tokens with a documented elevation
  ramp at the top. Extend the ramp rather than adding ad hoc colors.
- The page's URLs are all relative (`base: './'` in `vite.config.ts`, `api/...`
  in `App.tsx` and `index.html`), so it works under whatever prefix an
  application mounts it at. Keep new ones relative: a leading `/` breaks the
  mounted page, and only `e2e/mounted.e2e.ts` catches it.
