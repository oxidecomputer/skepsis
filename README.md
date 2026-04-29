# skepsis

> [σκέψις](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.04.0057:entry=ske/yis): viewing, perception by the senses. Examination, speculation, consideration.

A fully local browser-based code review UI. Review your (or your agent's) diff _before_ inflicting it on the world.

- GitHub-style split or unified diff view with syntax highlighting
- Mark files as viewed
- Inline review comments are written directly into source files as code comments
- Works with [jj](https://jj-vcs.dev/) and git (tries jj first, falls back to git)
- Vim-style navigation shortcuts (press `?` to see the list)

https://github.com/user-attachments/assets/698365ab-964c-4e38-a605-82bec4879f60

## Setup

Requires [Node.js](https://nodejs.org/) (v22+).

```
git clone https://github.com/oxidecomputer/skepsis.git
cd skepsis && npm install
```

Add an alias pointing to your clone so you can run it from any repo:

```
alias sk="npx --prefix ~/repos/skepsis tsx ~/repos/skepsis/cli.ts"
```

## Usage

Takes `-r`/`--revision`, `-f`/`--from`, and `-t`/`--to` flags for specifying
the commit range. The VCS is auto-detected. In jj mode, the flags are passed
straight to `jj diff`. In git mode, they have to be translated slightly. See the
examples below.

Each invocation picks a free port, so you can run multiple instances simultaneously.

### jj examples

`sk` is just an alias (see above). You can name it whatever you want.

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

The CLI starts a local HTTP server that shells out to `jj diff`
or `git diff`, then serves the diff to a React frontend that uses
[`@pierre/diffs`](https://diffs.com/) to render it with syntax highlighting.

The built frontend bundle is checked into `dist/` so that the production path
has no build step — the server serves it directly. In dev mode (`--dev`), a
Vite dev server runs alongside the API server with hot reload.

### Comments

Review comments are inserted into the source files, so they show up in your VCS
diff and are visible to coding agents. They can be resolved (deleted) from the
UI. Comments are only enabled when the diff includes the working copy (e.g.,
a revset ending in `@` for jj, or an open-ended range ending at the working
tree for git), since that's where the inserted lines land.

### Marking files viewed

Viewed state is stored per file in `~/.local/share/skepsis/` using the file's
content hash (the git object ID from the diff header). If the file changes, the
hash no longer matches and it automatically shows as unviewed again.

## Development

```
npm install
sk --dev    # Vite dev server with hot reload + API server
```

After changing frontend code, rebuild the checked-in bundle:

```
npm run build
```
