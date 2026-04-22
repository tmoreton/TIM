<div align="center">
  <img src="https://raw.githubusercontent.com/tmoreton/heytim-web/main/tim.svg" width="50%" alt="HeyTim">
  <br>
  <em>the minimalist coding companion</em>
  <br><br>
  <strong>~5,055 source lines of JavaScript · ZERO runtime dependencies</strong>
  <br><br>
  <p>A minimal AI coding assistant. Runs locally, works with any LLM provider (Fireworks, OpenRouter, etc.), gives the model file + shell tools, and wraps it in a ReAct loop.</p>
  <p>The whole point is to be readable—small enough to understand end-to-end.</p>
</div>

---

## Install

```bash
git clone https://github.com/tmoreton/TIM.git && cd TIM
npm link # installs the `tim` binary globally

tim /env set FIREWORKS_API_KEY=...
tim /env set OPENROUTER_API_KEY=...
tim /env set TAVILY_API_KEY=...   # optional, enables web_search
```

---

## Concepts

TIM has four building blocks. Knowing how they fit together makes everything else click.

```
agent          ← identity + memory + tool allowlist + system prompt
  └─ workflow  ← task spec bound to an agent (inherits identity + memory)
       └─ trigger  ← cron schedule that fires a workflow
```

- **Agent** — a long-lived persona. Owns a memory file (auto-loaded into every run), an optional tool allowlist, and a system prompt. Example: `traveling-developer` — your YouTube/X brand identity.
- **Workflow** — a task spec bound to an owning agent. Inherits the agent's identity + memory and adds task-specific instructions (and optionally a narrower tool allowlist). Example: `youtube-daily-report` — owned by `traveling-developer`, runs daily analytics + email.
- **Trigger** — a cron schedule that fires a workflow with an optional task override. The `tim start` daemon runs them.
- **Memory** — per-agent persistent context at `$TIM_DIR/memory/<agent>.md`. Auto-loaded into the system prompt each turn. The agent calls `append_memory` to save durable findings.

Inside a chat, the model can also create these for you via the `create_agent` and `create_workflow` tools — no need to learn the file format.

---

## Building your first agent

Three paths, same canonical file format.

### From inside a chat (easiest)

```
tim
> create an agent called "research" that focuses on web research and
  summarization. give it web_fetch, web_search, append_memory, spawn_workflow.
```

The model calls `create_agent` and writes `$TIM_DIR/agents/research.md` with the canonical schema. Memory file bootstrapped at `$TIM_DIR/memory/research.md`.

### Interactive CLI

```bash
tim agent new
```

Walks through name → description → tools → system prompt and writes the file.

### Hand-edit

Drop a markdown file in `$TIM_DIR/agents/`:

```md
---
# Agent identifier (kebab-case)
name: research

# One-line description shown in `tim agent list`
description: Web research + summarization

# Optional model override (e.g. claude-sonnet-4-6)
# model:

# Tool allowlist — omit for all tools
tools: [web_fetch, web_search, append_memory, spawn_workflow]
---

You are the research agent. ...
```

The schema is validated on load — typos, missing required fields, and wrong types (e.g. `tools: foo, bar` instead of `tools: [foo, bar]`) print clear errors with "did you mean" suggestions.

**Run the agent:**
```bash
tim research                 # interactive REPL with this agent
tim research "task here"     # interactive REPL, with an initial task
tim run research "task"      # headless, print result
```

---

## Adding a workflow

Workflows are reusable task specs bound to an agent. Same three paths.

### From a chat

```
tim research
> add a workflow called "morning-research" owned by the research agent. each
  morning it should pull HN top stories and summarize the 3 most relevant ones.
```

### CLI

```bash
tim workflow new
```

### Hand-edit

```md
---
name: morning-research
description: Daily HN summary
agent: research

# Default user message sent when fired without an override (used by triggers)
task: Pull top 3 HN stories and summarize

# Override the agent's tool allowlist for this workflow (optional)
# tools: [web_fetch]
---

When summarizing, structure as: title, 1-line takeaway, why it matters.
```

**`task` vs body:** `task` is the default user message (the question/instruction sent to the agent when fired). The body is the system-prompt extension that defines HOW the agent should approach this kind of task — appended to the agent's base prompt at runtime.

**Run a workflow:**
```bash
tim run morning-research                       # uses default task
tim run morning-research "custom task"         # override task
# Or from inside an agent: spawn_workflow("morning-research", "task")
```

---

## Scheduling with triggers

Triggers fire workflows on a cron schedule. The `tim start` daemon runs them.

```bash
tim trigger add morning-research-daily   # interactive: schedule, workflow, optional task
tim trigger list                         # see all
tim trigger run <name>                   # fire immediately for testing
tim trigger remove <name>
tim start                                # run the daemon (auto-restarts on crash)
```

Or hand-edit `$TIM_DIR/triggers/<name>.md`:

```md
---
name: morning-research-daily
schedule: "0 8 * * *"
workflow: morning-research
# task: optional override
---
```

---

## Custom tools

Drop a `.js` file in `src/tools/` that exports `tools = { name: { schema, run } }`:

```js
// src/tools/my_thing.js
export const tools = {
  my_thing: {
    schema: {
      type: "function",
      function: {
        name: "my_thing",
        description: "Does my thing.",
        parameters: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      },
    },
    run: async ({ x }, ctx) => `result: ${x}`,
    // Optional — silently dropped if env vars missing:
    // requiredEnv: "MY_API_KEY",
  },
};
```

Save and restart `tim`. Auto-discovered. No registry edits, no `index.js` changes. One file can register multiple tools — see `src/tools/fs.js` (4 tools) or `src/tools/scaffold.js` (2 tools) for examples.

---

## How it all connects

```
You → "research the news"
       │
       ▼
   [research agent]              ← identity + memory auto-loaded
       │
       ├─ has access to:  web_fetch, web_search, append_memory, spawn_workflow
       │
       ├─ may dispatch:   spawn_workflow("morning-research", "...")
       │                          │
       │                          ▼
       │                   [research agent + morning-research's extra prompt]
       │                          │
       │                          ▼
       │                   returns text result
       │
       └─ may call:       append_memory("Key finding", "...")  →  $TIM_DIR/memory/research.md
                                                                  (loaded into next run)

[trigger: morning-research-daily, "0 8 * * *"]
       │
       └─ each day at 8am:  fires `morning-research` workflow with default task
                            (no human in the loop — daemon does it)
```

---

## Tools

| Tool | Description |
|------|-------------|
| `list_files` | list directory contents |
| `read_file` | read file contents |
| `edit_file` | surgical string replacement |
| `write_file` | create or overwrite files |
| `bash` | shell commands with timeout |
| `grep` | regex search file contents |
| `glob` | find files by pattern |
| `web_fetch` | fetch and extract web pages |
| `web_search` | web search via Tavily (requires `TAVILY_API_KEY`) |
| `update_memory` | overwrite agent memory file |
| `append_memory` | append dated section to agent memory file |
| `capture_webpage` | screenshot a URL via headless Chrome |
| `capture_desktop` | screenshot the user's desktop |
| `spawn_workflow` | run a workflow as a sub-session |
| `create_agent` | scaffold a new agent file from inside a chat |
| `create_workflow` | scaffold a new workflow file from inside a chat |

---

## `.tim` Directory Structure

TIM stores all user data, configuration, and state in `~/.tim` (or `$TIM_DIR`):

```
~/.tim/
├── .env                    # API keys and env vars (auto-loaded)
├── TIM.md                  # global rules + directory conventions (auto-bootstrapped)
├── agents/                 # Agent profiles (*.md with frontmatter)
├── workflows/              # Workflow task specs (*.md)
├── triggers/               # Scheduled cron triggers (*.md)
├── memory/                 # Agent memory files (*.md)
├── sessions/               # Saved conversation history (JSON, grouped by folder)
└── images/                 # Screenshots from capture_webpage/capture_desktop
```

| Path | Purpose |
|------|---------|
| `.env` | Environment variables auto-loaded on startup. Set via `/env set KEY=val` |
| `TIM.md` | Global rules + directory conventions. Loaded into every system prompt |
| `agents/` | Agent identity profiles (schema-validated on load) |
| `workflows/` | Task specs bound to an agent (schema-validated on load) |
| `triggers/` | Cron-scheduled workflows. Run by `tim start` daemon |
| `memory/` | Persistent agent memory. Auto-loaded into context |
| `sessions/` | Saved REPL conversations. Resume with `tim --resume` or `/sessions` |
| `images/` | Screenshots saved by capture_* tools |

A project-local `TIM.md` in your cwd is also loaded (after the global one) — use it for project-specific rules.

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | show this help |
| `/tools` | list available tools |
| `/model [#\|id]` | show or switch model |
| `/agents` | list agents |
| `/agent <name>` | run agent (optionally with task or @file) |
| `/workflows` | list workflows |
| `/workflow <name>` | run workflow |
| `/triggers` | list scheduled cron triggers |
| `/memory [agent]` | show agent memory path/contents |
| `/loc` / `/sloc` | source lines of code (with/without comments) |
| `/clear` | start a new session |
| `/compact` | summarize old messages |
| `/sessions` | list saved conversations |
| `/auto` | toggle auto-accept |
| `/plan` | draft without executing |
| `/env` | manage env vars (list/set/unset) |
| `/exit` | quit |

---

## CLI Flags

| Command | Description |
|---------|-------------|
| `tim` | start fresh interactive session |
| `tim chat` | general chat — session filed under `general` regardless of cwd |
| `tim <agent>` | chat interactively with a specific agent |
| `tim <agent> --yolo` | chat with agent + auto-accept mode |
| `tim --resume [id]` | resume latest session, or by id |
| `tim --list` | list saved sessions |
| `tim --yolo` | start with auto-accept enabled |
| `tim run <workflow\|agent> "task"` | run headlessly |
| `tim agent new\|list\|edit\|delete` | manage agents |
| `tim workflow new\|list\|edit\|delete` | manage workflows |
| `tim trigger list\|add\|remove\|run` | manage scheduled triggers |
| `tim start` | start the cron scheduler daemon |

---

## Project Layout

```
src/
├── index.js          # CLI entry: parse args, start REPL or headless mode
├── react.js          # ReAct loop: stream LLM, execute tool calls, track tokens
├── repl.js           # Readline interface: input, attachments, SIGINT
├── llm.js            # API clients for Fireworks + OpenRouter with SSE parser
├── agents.js         # Load + write agent profiles (schema-driven)
├── workflows.js      # Load + write workflows (schema-driven)
├── triggers.js       # Cron triggers: load, write, fire
├── cron.js           # Minimal cron expression parser + matcher
├── commands.js       # Slash commands: /help, /model, /agent, /env, etc
├── permissions.js    # Confirm prompts, auto-accept (/yolo), plan mode
├── ui.js             # ANSI colors, spinner, markdown rendering, banners
├── config.js         # Load TIM.md context files (global + project)
├── env.js            # Read/write $TIM_DIR/.env, push to process.env
├── memory.js         # Agent memory persistence
├── session.js        # Save/load conversation sessions
├── history.js        # Git snapshot of $TIM_DIR before destructive writes
├── cache.js          # LRU cache for deterministic tools (read/grep/list)
├── server.js         # HTTP server, scheduler daemon
├── paths.js          # Path helpers + frontmatter parser, validator, renderer
└── tools/
    ├── index.js      # Auto-discovers all *.js exporting `tools = {...}`
    ├── fs.js         # list_files, read_file, edit_file, write_file
    ├── bash.js       # shell command execution with timeout
    ├── search.js     # grep and glob search
    ├── spawn.js      # spawn_workflow: run sub-agents headlessly
    ├── web_fetch.js  # fetch + extract web pages
    ├── web_search.js # Tavily web search
    ├── memory.js     # update_memory, append_memory
    ├── screenshot.js # capture_webpage, capture_desktop
    └── scaffold.js   # create_agent, create_workflow
```

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `FIREWORKS_API_KEY` | *(required)* | API key (Fireworks AI) |
| `OPENROUTER_API_KEY` | — | API key (OpenRouter for more models) |
| `TIM_MODEL` | `accounts/fireworks/routers/kimi-k2p5-turbo` | model ID |
| `TIM_CONTEXT_LIMIT` | `128000` | context window (for `/compact` warning) |
| `TAVILY_API_KEY` | — | Web search API |
| `TIM_DIR` | `~/.tim` | root for all user data |
| `TIM_AUTO_ACCEPT` | — | set to `1` to default to auto-accept on startup |
| `TIM_SESSION_FOLDER` | — | force session folder name (used by `tim chat`) |
