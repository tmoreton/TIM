# tim

**~1,475 lines of JavaScript · zero magic · zero runtime dependencies** (requires Node ≥22)

A minimal, single-developer clone of Claude Code. Runs locally, talks to the Fireworks AI API, uses Kimi K2.5 Turbo, gives the model a handful of file + shell tools, and wraps it in a ReAct loop.

The whole point is to be readable. If you want to understand how coding agents work end-to-end, this is a small enough codebase to hold in your head.

---

## Install

```bash
git clone <this-repo> TIM && cd TIM
npm install
npm link                      # installs the `tim` binary globally
export FIREWORKS_API_KEY=...   # add to your shell profile
```

Now `tim` runs from anywhere. `cd` into a project, type `tim`, and you're in a REPL.

---

## Project layout

```
TIM/
├── package.json              # bin entry → ./src/index.js
├── README.md
└── src/
    ├── index.js              # entry: REPL, argv, SIGINT, multi-line input
    ├── agent.js              # ReAct loop, streaming, token tracking, compaction
    ├── llm.js                # native fetch + SSE parser for Fireworks
    ├── ui.js                 # ANSI colors, spinner, markdown renderer, diffs
    ├── commands.js           # slash commands (/help, /clear, /compact, /yolo, ...)
    ├── config.js             # loads TIM.md (global + project) into the system prompt
    ├── permissions.js        # y/a/n confirm + auto-accept toggle
    ├── session.js            # save/load ~/.tim/sessions/<id>.json
    └── tools/
        ├── index.js          # tool registry
        ├── fs.js             # list_files, read_file, edit_file, write_file
        ├── bash.js           # bash tool with timeout + abort
        └── search.js         # grep (rg w/ Node fallback) and glob (fs.glob)
```

Each file is small enough to read in one sitting. Start with `src/index.js` and follow the imports.

---

## How it works

### 1. The REPL (`src/index.js`)

A thin `readline` loop. Reads a line, decides whether it's a slash command, a multi-line continuation, or a real prompt, and hands real prompts to `agentTurn()`.

Extras it handles:
- **Multi-line input** — trailing `\` continues the current line; `"""` on its own line toggles a heredoc block.
- **Ctrl+C** — first hit mid-turn aborts the request (and kills any running bash child). Double-tap at the idle prompt exits.
- **Launch flags** — `tim --resume [id]`, `tim --list`, `tim --yolo` (auto-accept).

### 2. The ReAct loop (`src/agent.js`)

This is the engine. Pseudocode:

```
push user message
loop:
    call Fireworks → stream back assistant message (text + tool calls)
    if no tool calls: done
    for each tool call:
        run the tool locally
        push the result as a "tool" message
save session
```

A few details that matter:
- **Streaming.** We use `stream: true` + `stream_options.include_usage`. Content tokens print as they arrive; tool-call deltas are accumulated by `index` across chunks (name and arguments are concatenated).
- **Abort.** Every turn owns an `AbortController`. The signal is passed to the OpenAI SDK *and* to each tool's `run(args, {signal})`, so bash children get killed on Ctrl+C.
- **Auto-save.** After every turn (even interrupted ones), we write the full message history to `~/.tim/sessions/<id>.json`. `--resume` picks it back up.
- **Compaction.** `/compact` asks the model to summarize older messages and replaces the middle of the history with `[summary, ack]`, keeping the system prompt and the last few turns.

### 3. Tools (`src/tools/`)

Each tool is `{ schema, run }`. The schema is an OpenAI function-calling schema; `run` does the work. All tools live in `tools/index.js`'s registry — add a new file there to add a capability.

| Tool | What it does | Asks permission? |
|---|---|---|
| `list_files` | `readdir` filtered to non-hidden entries | no |
| `read_file` | read text file, records path for Read-before-Edit | no |
| `edit_file` | string-replace edit (unique match, or `replace_all`) | yes |
| `write_file` | create or overwrite | yes |
| `bash` | spawn `bash -c` with timeout, capture stdout/stderr | yes |
| `grep` | `rg` with a Node `fs.glob` fallback | no |
| `glob` | Node's native `fs.glob` (async iterable) | no |

Two invariants worth knowing:
- **Paths are sandboxed** to the current working directory. `../` tricks are blocked by a proper prefix check (`abs === cwd || abs.startsWith(cwd + path.sep)`).
- **You must `read_file` before `edit_file`.** The rule prevents blind edits. The read-set is rehydrated from message history on resume, so it survives restarts.

### 4. Permissions (`src/permissions.js`)

Before `edit_file`, `write_file`, or `bash`, the tool calls `confirm()`, which prompts the user:

```
⚠ bash wants to run:
    git status
  [y]es / [a]lways this session / [n]o >
```

`a` allowlists for the rest of the session. Bash is keyed on the first word, so allowing `git status` lets all `git *` commands through until you restart.

If the user denies, the tool returns `"User denied the command."` — the model sees it as a normal tool result and adapts.

The prompt shares the main `readline` (`setReadline(rl)` in `index.js`) so there's no dueling stdin listener fighting with the REPL.

### 5. Slash commands (`src/commands.js`)

Handled before anything ever hits the model:

| Command | Effect |
|---|---|
| `/help` | list commands |
| `/tools` | list registered tools |
| `/model [id]` | show or switch model |
| `/clear` | start a new session |
| `/context` | is a `TIM.md` loaded? |
| `/tokens` | last-prompt and cumulative token usage |
| `/compact` | summarize + truncate history |
| `/sessions` | list saved sessions |
| `/yolo` | toggle auto-accept for edits and bash (use with care) |
| `/exit` | quit |

### 6. Project context (`src/config.js`)

On startup, tim looks for:
1. `~/.tim/TIM.md` — global conventions
2. `./TIM.md` — per-project conventions

Both are appended to the system prompt. Use this like `CLAUDE.md`: short, specific notes about the repo (how to run tests, where things live, style preferences).

### 7. Sessions (`src/session.js`)

Each conversation is a JSON file in `~/.tim/sessions/`:

```json
{
  "id": "2026-04-15T14-30-00-000",
  "cwd": "/path/to/project",
  "model": "accounts/fireworks/routers/kimi-k2p5-turbo",
  "createdAt": 1713189000000,
  "updatedAt": 1713189300000,
  "messages": [ ... ],
  "usage": { "prompt": 12345, "completion": 6789, "lastPrompt": 4321 }
}
```

Resume with `tim --resume` (latest) or `tim --resume <id>`. `/sessions` lists them.

---

## A typical session

```
$ cd ~/my-project
$ tim
tim (accounts/fireworks/routers/kimi-k2p5-turbo) in /Users/me/my-project
Type /help for commands. End a line with \ to continue; """ toggles a multi-line block.

you> what does this project do?
  · list_files({"path":"."})
  · read_file({"path":"package.json"})
  · read_file({"path":"README.md"})

tim> It's a small Express API that...

you> add a /health endpoint that returns 200 OK
  · grep({"pattern":"app\\.(get|post)","path":"src"})
  · read_file({"path":"src/server.js"})
  · edit_file({"path":"src/server.js"})

  ⚠ edit_file wants to run:
    edit src/server.js
  [y]es / [a]lways this session / [n]o > y

tim> Added a GET /health handler that returns { status: 'ok' }.

you> /compact
compacting...
Compacted. Kept 6 messages.

you> ^C
(press Ctrl+C again to exit)
you> ^C
bye.
```

---

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `FIREWORKS_API_KEY` | *(required)* | Fireworks API key |
| `TIM_MODEL` | `accounts/fireworks/routers/kimi-k2p5-turbo` | model ID |
| `TIM_CONTEXT_LIMIT` | `128000` | used only to compute the `/compact` warning |

---

## Extending

**Adding a tool** is four steps:
1. Create `src/tools/<name>.js` exporting `{ schema, run }`.
2. Import it in `src/tools/index.js` and add it to the `tools` map.
3. If it mutates state, call `confirm(toolName, args, preview)` from `src/permissions.js`.
4. If it's long-running, respect `ctx.signal` for Ctrl+C.

**Adding a slash command** is two lines in `src/commands.js`.

**Swapping the model provider** is one change: the `baseURL` and `apiKey` in `src/agent.js::getClient()`. Any OpenAI-compatible endpoint works.

---

## What's intentionally missing

This is a tutorial codebase, not a product. It does not have:

- Subagents / Task tool
- MCP servers
- Image / PDF input
- A web UI
- .gitignore-aware search in the Node fallback (rg handles it)
- Retry on transient API errors

Add them if you want — each one is a small, local change.
