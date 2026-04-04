# skepsis

A browser-based code review UI for local diffs. Works with
[jj](https://jj-vcs.dev/) and git — tries jj first, falls back to git.
GitHub-style split/unified diff view with syntax highlighting, file-viewed
tracking, and inline review comments written directly into source files as `//
REVIEW: ...` markers.

https://github.com/user-attachments/assets/698365ab-964c-4e38-a605-82bec4879f60

## Setup

Requires [Node.js](https://nodejs.org/) (v22+).

```
git clone https://github.com/oxidecomputer/skepsis.git
cd skepsis && npm install
```

Add an alias so you can run it from any repo:

```
alias sk="npx --prefix ~/oxide/skepsis tsx ~/oxide/skepsis/cli.ts"
```

## Usage

Takes `-r`, `-f`, and `-t` flags. The VCS is auto-detected. In jj mode, the
flags are passed straight to `jj diff`. In git mode, they have to be translated
slightly. See the examples below.

Each invocation picks a free port, so you can run multiple instances simultaneously.

Review comments are inserted into the source files, so they show up in your
VCS diff and can be resolved (deleted) from the UI. Viewed-file state is
persisted per session in `~/.local/share/skepsis/`.

### jj examples

```
sk                          # review trunk()..@
sk -r @                     # review working copy only
sk -r 'mybranch..@'         # review a range
sk -f main -t @             # diff between two revisions
```

### git examples

Ranges passed with `-r` are passed through verbatim to `git diff`.

```
sk                          # git diff origin/HEAD..HEAD
sk -f main                  # diff since main: git diff main HEAD
sk -r main..my-branch       # review commits on my-branch
sk -r HEAD~5..HEAD          # review the last 5 commits
sk -f v1.2.0 -t v1.3.0      # compare two tags
sk --git                    # force git in a jj-colocated repo
```

## How it works

The built frontend bundle is checked into `dist/` so that the production path
has no build step — the server serves it directly. In dev mode (`--dev`), a
Vite dev server runs alongside the API server with hot reload.

## Development

```
npm install
sk --dev    # Vite dev server with hot reload + API server
```

After changing frontend code, rebuild the checked-in bundle:

```
npm run build
```
