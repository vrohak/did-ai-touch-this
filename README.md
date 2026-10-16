# Did AI touch this?

A local web app that shows which files and folders Claude Code and Codex read, changed or searched, as a folder tree built from their transcripts. Pick any file or folder to see the sessions that touched it, and copy the command that resumes one.

## Run it

Needs Node 24.2 or later.

```sh
npm start
```

Then open <http://localhost:4477> (set `PORT` to use another port). The first start reads every transcript, which takes about a minute for a few gigabytes; later starts and **Rescan** only read new and growing transcripts.

It reads Claude Code transcripts from `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and Codex rollouts from `~/.codex/sessions` and `~/.codex/archived_sessions` (or the same under `$CODEX_HOME`).

## What the tree shows

Each folder counts the paths under it that were:

- **Read**: a file's content was read.
- **Changed**: created, edited, moved or deleted.
- **Searched**: a folder was listed or searched, or a file's existence checked. Searching a folder doesn't count as reading the files in it. Hidden unless you tick **Searched**.

A touch is either **recorded** by a file tool (Claude's Read, Edit, Write, Grep and Glob; Codex's patches) or **inferred** from a shell command or inline script, such as `cat`, `sed -i`, `Get-Content`, `> file` or a Python heredoc that rewrites a file. Inferred touches show as rings rather than dots; untick **Inferred** to hide them. Codex reads almost entirely through the shell, so most of its reads are inferred.

**Coverage** is the share of a folder's files on disk now that were read and changed. Inside a git repo it counts the files git tracks or would track, so ignored build output and dependencies don't count; elsewhere it leaves out dependency and cache folders such as `node_modules`. Folders too big to count show a dash.

Files and folders that were touched but are gone from disk are marked **not on disk**. Claude Code worktrees (`.claude/worktrees/<name>`) count as their repo.

## What it can miss

Inferred touches are a best guess from the command's text. They miss paths a command builds at runtime, files a script reads that the command doesn't name, and commands it doesn't know. Now and then one is wrong, such as a relative path after a `cd` that failed.

## Privacy

The server listens only on this machine and answers only pages served from it. It caches what it found (paths, session ids and titles, never file contents) in `%LOCALAPPDATA%\did-ai-touch-this\index.json` on Windows, or `~/.cache/did-ai-touch-this/index.json` elsewhere.

## Development

```sh
npm test        # behaviour tests
npm run check   # type-check
```
