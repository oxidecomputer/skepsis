# local-review

A browser-based code review UI for local jj (Jujutsu) diffs. Shows a GitHub-style
split/unified diff view with syntax highlighting and file-viewed tracking. Inline
review comments are written directly into source files as `// REVIEW: ...` markers.

## Usage

Run in this repo and specify the target CWD with `-C`:

```
bun run start [-r <revset>] [-C <dir>]
```

Or run directly in the target repo by pointing to the script directly.

```
bun ~/repos/local-review/cli.ts -r 'trunk()..@'
```

This starts the API server and Vite dev server, then opens the browser. The revset
defaults to `@` (the current jj working copy).

Review comments are inserted into the actual source files, so they show up in the
diff itself and can be resolved (deleted) from the UI. Viewed-file state is persisted
per session (keyed by the revset's change IDs) in a `.local-review/` directory.

## Development

```
bun install
bun run dev     # Vite only (no API server)
```
