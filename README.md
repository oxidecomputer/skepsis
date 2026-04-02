# skepsis

A browser-based code review UI for local [jj](https://jj-vcs.dev/) diffs.
GitHub-style split/unified diff view with syntax highlighting, file-viewed
tracking, and inline review comments written directly into source files as
`// REVIEW: ...` markers.

## Setup

Requires [Bun](https://bun.sh/).

```
git clone https://github.com/oxidecomputer/skepsis.git
cd skepsis && bun install
```

Add an alias so you can run it from any jj repo:

```
alias sk="bun ~/oxide/skepsis/cli.ts"
```

## Usage

Takes the same `-r`, `-f`, and `-t` flags as `jj diff` and passes them
directly to jj when generating the diff.

```
$ sk -h
Usage: skepsis [options]

Local diff review UI for jj

Options:
  -r, --revisions <revsets>  show changes in these revisions
  -f, --from <revset>        show changes from this revision
  -t, --to <revset>          show changes to this revision
  --dev                      run with Vite dev server for tool development
  -h, --help                 display help for command
```

```
sk                          # review trunk()..@
sk -r @                     # review working copy only
sk -r 'mybranch..@'         # review a range
sk -f main -t @             # diff between two revisions
```

Each invocation picks a free port, so you can run multiple instances simultaneously.

Review comments are inserted into the source files, so they show up in `jj diff`
and can be resolved (deleted) from the UI. Viewed-file state is persisted per
session in `~/.local/share/skepsis/`.

## Development

```
bun install
sk --dev    # Vite dev server with hot reload + API server
```
