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

Requires [Node.js](https://nodejs.org/) v22+.

Run it without installing:

```
npx @oxide/skepsis
```

`npx` may reuse a cached package version. To force the newest published
version, run:

```
npx @oxide/skepsis@latest
```

To install a persistent command:

```
npm install --global @oxide/skepsis
skepsis
```

Either way, you may want a shorter alias:

```
alias sk="npx @oxide/skepsis"
```

## Usage

Takes `-r`/`--revision`, `-f`/`--from`, and `-t`/`--to` flags for specifying
the commit range. The VCS is auto-detected. In jj mode, the flags are passed
straight to `jj diff`. In git mode, they have to be translated slightly. See the
examples below.

Each invocation picks a free port, so you can run multiple instances simultaneously.

### jj examples

The examples use `skepsis`, the installed bin name. An `sk` alias works the
same way.

```
skepsis                          # review trunk()..@
skepsis -r @                     # review working copy only
skepsis -r 'mybranch..@'         # review a range
skepsis -f main -t @             # diff between two revisions
```

### git examples

Ranges passed with `-r` are passed through verbatim to `git diff`.

```
skepsis                          # git diff origin/HEAD..HEAD
skepsis -f main                  # diff since main: git diff main HEAD
skepsis -r main..my-branch       # review commits on my-branch
skepsis -r HEAD~5..HEAD          # review the last 5 commits
skepsis -f v1.2.0 -t v1.3.0      # compare two tags
skepsis --git                    # force git in a jj-colocated repo
```

## How it works

The CLI starts a local HTTP server that shells out to `jj diff`
or `git diff`, then serves the diff to a React frontend that uses
[`@pierre/diffs`](https://diffs.com/) to render it with syntax highlighting.

The npm package ships compiled CLI/server JavaScript plus a prebuilt frontend
bundle, so installing or running with `npx` does not build anything. In dev
mode (`--dev`), a Vite dev server runs alongside the API server with hot
reload from a source checkout.

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

Clone the repo when working on skepsis itself:

```
git clone https://github.com/oxidecomputer/skepsis.git
cd skepsis && npm install
```

Running from a checkout requires Node v22.18+, since the CLI runs as
TypeScript directly via Node's built-in type stripping. Point an alias at the
clone to run it from any repo:

```
alias sk="node ~/repos/skepsis/cli.ts"
```

`--dev` runs a Vite dev server with hot reload alongside the API server:

```
sk --dev
```

Before committing changes, run:

```
npm run ci
```
