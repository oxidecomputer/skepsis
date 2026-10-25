# skepsis

> [σκέψις](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.04.0057:entry=ske/yis): viewing, perception by the senses. Examination, speculation, consideration.

A fast, fully local browser-based code review UI. Review your (or your agent's) diff _before_ inflicting it on the world.

- Fast even with huge diffs
- GitHub-style split or unified diff view with syntax highlighting
- Mark files as viewed
- Inline review comments are written directly into source files as code comments or piped to a specified command
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

Each invocation picks a free port by default, so you can run multiple instances
simultaneously. To use a specific port, pass `--port`/`-p`:

```
skepsis --port 8080
```

Use `--host` as well if the server needs to be reachable from another machine:

```
skepsis --host 0.0.0.0 --port 8080
```

In `--dev` mode, `--port` sets the browser-facing Vite port; the proxied API
server continues to use a free port.

skepsis opens the page in a browser when it starts on localhost. Pass
`--no-open` to skip that, for example when a script starts it in the
background: once the server is listening, it prints one line to stdout,
`skepsis on <url> (<diff command>)`.

The URL ends in `#token=…`, a secret made fresh on each run. The page needs it
to talk to the server, so open that URL, not just the host and port. After that,
reloads and new tabs on the same address work in that browser; a different
browser needs the full URL again.

To open it some other way, such as in a particular browser or a window of
its own, pass `--open-cmd <command>` (or set `SKEPSIS_OPEN` in the
environment). skepsis runs it with `sh -c`, with the URL appended as the last
argument:

```
skepsis --open-cmd 'open -a Firefox'
```

`--dev` mode ignores it, since Vite opens the page itself.

### jj examples

The examples use `skepsis`, the installed bin name. An `sk` alias works the
same way.

```
skepsis                          # review branch vs trunk, GitHub PR style
                                 # (jj diff --from 'fork_point(trunk() | @)')
skepsis -r @                     # review working copy only
skepsis -r 'mybranch..@'         # review a range
skepsis -f main -t @             # diff between two revisions
```

### git examples

Ranges passed with `-r` are passed through verbatim to `git diff`.

```
skepsis                          # review branch + working tree vs origin
                                 # (git diff --merge-base origin/HEAD; falls
                                 # back to origin/main, origin/master, main,
                                 # master)
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

While the page is visible, it reruns the diff every few seconds in the
background, and again as soon as you come back to the tab. When the diff has
changed, it shows a toast with a Refresh button and a list of which files
changed and by how many lines. The displayed diff never changes under you on
its own. Pass `--no-poll` to turn this off.

The npm package ships compiled CLI/server JavaScript plus a prebuilt frontend
bundle, so installing or running with `npx` does not build anything. In dev
mode (`--dev`), a Vite dev server runs alongside the API server with hot
reload from a source checkout.

### Comments

Review comments are inserted into the source files, so they show up in your VCS
diff and are visible to coding agents. They can be resolved (deleted) from the
UI. Comments are only enabled when the diff includes the working copy (e.g.,
a revset ending in `@` for jj, or an open-ended range ending at the working
tree for git), since that's where the inserted lines land. The default diff
in both modes ends at the working copy, so comments are enabled by default.

### Marking files viewed

Viewed state is stored per file in `~/.local/share/skepsis/` using the file's
content hash (the git object ID from the diff header). If the file changes, the
hash no longer matches and it automatically shows as unviewed again.

### Sending comments to another program

`--send <command>` (or `SKEPSIS_SEND` in the environment) adds a **Send** button
to the comment box, which pipes the comment to a shell command instead
of writing it into the file. Use it to pass review comments straight to a coding
agent, a tmux pane, or a log. There is not chat UI in skepsis (yet) so replies
from the agent will appear in that session, wherever it is. Send works
in some cases that inline comments can't (because there is no file to write): on
removed lines, and on diffs that don't end at the working copy. The **Comment**
button continues to write a `<review>` marker in the file as usual.

The only way to set the command is `--send` or `SKEPSIS_SEND`. skepsis never
reads it from the repo contents, so reviewing someone else's branch
can't make it run a command they chose. Only the page skepsis opened can
trigger a send (see Security below).

skepsis runs the command with `sh -c` in the directory it was started in. The
command inherits skepsis's environment (which is how the agent samples find
their session), plus `SKEPSIS_URL`, the page's address, and `SKEPSIS_ROOT`, the
directory skepsis was started in. It gets the comment on stdin as one line of
JSON whose `prompt` field is the whole comment as a message. Some sample
commands to start from:

```sh
# Claude Code. CLAUDE_CODE_MESSAGING_SOCKET is only set in commands the session
# runs; from any other shell, use the session's socket path instead
# (/tmp/cc-socks/<pid of claude>.sock)
SKEPSIS_SEND='jq -c "{type:\"user\",message:{role:\"user\",content:.prompt}}" | nc -U "$CLAUDE_CODE_MESSAGING_SOCKET"'

# Codex. CODEX_THREAD_ID is likewise only set inside the session
SKEPSIS_SEND='codex queue --thread "$CODEX_THREAD_ID" --message "$(jq -r .prompt)"'

# a tmux pane named review, pasted so newlines don't submit early
SKEPSIS_SEND='jq -r .prompt | tmux load-buffer -b skepsis - && tmux paste-buffer -p -d -b skepsis -t review && tmux send-keys -t review Enter'

# a log file
SKEPSIS_SEND='jq -c . >> ~/review-comments.jsonl'
```

<details>
<summary>JSON format and exit status</summary>

The JSON sent to stdin looks like this:

````json
{
  "version": 1,
  "root": "/home/me/project",
  "diff": { "command": "jj diff -r @-", "toWorkingCopy": false },
  "file": "src/a.ts",
  "side": "additions",
  "lines": [42, 45],
  "code": [{ "lines": [41, 46], "text": "const z = 0\nconst a = 1\n…" }],
  "blob": "9daeafb",
  "text": "why two?",
  "prompt": "Review comment on src/a.ts, lines 42–45 (new side of `jj diff -r @-`), in lines 41–46:\n\n```\nconst z = 0\nconst a = 1\n…\n```\n\nwhy two?"
}
````

`side` is `additions` or `deletions`, and `lines` (1-based, inclusive) are in
that side's numbering. `code` is an excerpt of that side around the lines
commented on, in runs of consecutive lines, each with its own first and last
line. There's more than one run when the lines commented on span lines the
diff doesn't show. `blob` is the ID of the
version of the file those line numbers refer to (old or new, by `side`), or
null where the diff has none, as for an added file's old side or a pure
rename. It's the version on the page, which is older than the file on disk if
the file changed since the page last refreshed. `prompt` is all of it as plain text, for consumers that only want a
message.

Exit 0 means the comment was delivered, and the page keeps the comment in the
diff, under the line it was on, until you dismiss it or reload. skepsis ignores
stdout. Any other exit, or running past 10 seconds, is a failure: the page shows
stderr (or the exit status) and keeps the comment in the box. Sends run one at a
time, in the order they were submitted.

</details>

<details>
<summary>Notes on security</summary>

A request to `/api/send` can't set the command, but it does pipe arbitrary text
to it, so lock down who is allowed to hit the endpoint by requiring a token. The
token is generated per run of the server and passed to the page in the `#token=`
fragment of the URL it opens. The page keeps it in `localStorage`, which only
pages on that host and port can read. This keeps out other websites in the
browser and anything coming in through a forwarded port. It doesn't keep out
other users on the machine or other processes running as you.

As a backup, `--send` also requires a loopback `--host`, and `/api/send` rejects
requests whose `Host` isn't a loopback name or whose `Origin`
isn't the page's own.

</details>

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

## Versioning

- **patch** — bug fixes, dependency bumps, internal changes
- **minor** — new features: flags, keyboard shortcuts, UI capabilities
- **major** — breaking changes to anything scriptable or on disk: removed or
  renamed flags, changed flag defaults, changed `<review>` comment or
  viewed-state formats, removed or changed fields in the `--send` JSON
  (adding a field is minor)

## Releases

To publish a release, bump the version and land the change on `main`:

```
npm version patch --no-git-tag-version   # or minor/major — bumps package.json
jj commit -m 'v0.1.1'                    # land the bump on main via PR
```

On every push to `main`, CI checks whether the `package.json` version is
already on the registry. If not, it publishes and creates a matching [GitHub
release](https://github.com/oxidecomputer/skepsis/releases) like `v0.1.1` with
auto-generated notes listing the PRs merged since the previous release.

To publish a canary build of a PR, go to the [Release
workflow](https://github.com/oxidecomputer/skepsis/actions/workflows/release.yml),
click "Run workflow", and enter the PR number. It publishes the PR's head as
`<version>-canary.<pr>.<sha>` under the `canary` dist-tag and comments the
version on the PR.
