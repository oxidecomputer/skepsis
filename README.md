# local-review

A browser-based code review UI for local jj (Jujutsu) diffs. Shows a GitHub-style
split/unified diff view with syntax highlighting and file-viewed tracking. Inline
review comments are written directly into source files as `// REVIEW: ...` markers.

## Usage

Set up a shell alias pointing to the CLI entry point:

```
alias sk="bun ~/repos/skepsis/cli.ts"
```

Then run it from any jj repo:

```
sk                          # review trunk()..@
sk -r @                     # review working copy only
sk -r 'mzbranch..@'        # review a range of revisions
sk -f main -t @             # diff between two specific revisions
```

Each invocation picks a random free port, so you can run multiple instances
in different repos simultaneously.

You can also run from this repo with `-C` to point at a different working
directory:

```
bun run start -C ~/oxide/omicron -r @
```

This starts the API server, builds the frontend, and opens the browser. The
revset defaults to `trunk()..@`.

Review comments are inserted into the actual source files, so they show up in the
diff itself and can be resolved (deleted) from the UI. Viewed-file state is persisted
per session (keyed by the revset's change IDs) in a `.local-review/` directory.

## Development

```
bun install
bun run dev     # Vite only (no API server)
```
