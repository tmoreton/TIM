<div align="center">
  <img src="https://raw.githubusercontent.com/tmoreton/heytim-web/main/tim.svg" width="50%" alt="HeyTim">
  <br>
  <em>the minimalist coding companion</em>
  <br><br>
  <strong>~5,250 source lines of JavaScript · ZERO runtime dependencies</strong>
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
tim /env set TAVILY_API_KEY=...
```

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
| `spawn_workflow` | run sub-agents headlessly |
| `web_fetch` | fetch and extract web pages |
| `web_search` | web search via Tavily (requires `TAVILY_API_KEY`) |
| `update_memory` | overwrite agent memory file |
| `append_memory` | append to agent memory file |

## Agents


| Agent | Description |
|------|-------------|
| `agent` | run agent |
| `workflow` | run workflow |
| `trigger` | scheduled cron triggers |
| `memory` | agent memory path/contents |

## Project Layout

```
src/
├── index.js          # CLI entry: parse args, start REPL or headless mode
├── react.js          # ReAct loop: stream LLM, execute tool calls, track tokens
├── repl.js           # Readline interface: input handling, attachments, SIGINT
├── llm.js            # API clients for Fireworks + OpenRouter with SSE parser
├── agents.js         # Load agent profiles from .tim/agents/*.md
├── workflows.js      # Load workflows from .tim/workflows/*.md
├── triggers.js       # Scheduled triggers (cron) persistence + state
├── cron.js           # Minimal cron expression parser + matcher
├── start.js          # Scheduler daemon: run triggers on schedule
├── commands.js       # All slash commands: /help, /model, /agent, /env, etc
├── permissions.js    # Confirm prompts, auto-accept (/yolo), plan mode
├── ui.js             # ANSI colors, spinner, markdown rendering, banners
├── config.js         # Load TIM.md context files (global + project)
├── env.js            # Read/write $TIM_DIR/.env, push to process.env
├── memory.js         # Agent memory persistence: read/write .tim/memory/*.md
├── session.js        # Save/load conversation sessions to .tim/sessions/
├── history.js        # Git snapshot of $TIM_DIR before destructive writes
├── cache.js          # LRU cache for deterministic tools (read/grep/list)
├── mcp.js            # MCP server management: connect, tools, lifecycle
├── server.js         # HTTP server, scheduler daemon
├── paths.js          # TIM_SOURCE_ROOT + path helpers
└── tools/
    ├── index.js      # Tool registry: core + custom + MCP merge
    ├── fs.js         # list_files, read_file, edit_file, write_file
    ├── bash.js       # shell command execution with timeout
    ├── search.js     # grep and glob search
    ├── spawn.js      # spawn_workflow: run sub-agents headlessly
    ├── web_fetch.js  # fetch + extract web pages
    ├── web_search.js # Tavily web search
    ├── memory.js     # update_memory, append_memory
    └── custom.js     # Load custom tools from .tim/tools/*.js
```

---

## `.tim` Directory Structure

TIM stores all user data, configuration, and state in `~/.tim` (or `$TIM_DIR`):

```
~/.tim/
├── .env                    # API keys and env vars (auto-loaded)
├── agents/                 # Agent profiles (*.md with frontmatter)
│   ├── youtube.md
│   └── github-reviewer.md
├── workflows/              # Workflow task specs (*.md)
│   ├── daily-report.md
│   └── pr-summary.md
├── memory/                 # Agent memory files (*.md)
│   ├── youtube.md          # Persistent context per agent
│   └── github-reviewer.md
├── sessions/               # Saved conversation history (JSON)
│   ├── 2024-01-15-abc123.json
│   └── 2024-01-16-def456.json
├── triggers/               # Scheduled cron triggers (*.md)
│   └── morning-digest.md
├── tools/                  # Custom user tools (*.js)
│   └── my-api-client.js
└── mcp.json                # MCP server configuration
```

| Path | Purpose |
|------|---------|
| `.env` | Environment variables auto-loaded on startup. Set via `/env set KEY=val` |
| `agents/` | Agent identity profiles. Each defines tools, system prompt, and description |
| `workflows/` | Task specs that pair an agent with a specific prompt and optional precheck |
| `memory/` | Persistent agent memory. Survives across sessions, auto-loaded into context |
| `sessions/` | Saved REPL conversations. Resume with `tim --resume` or `/sessions` |
| `triggers/` | Cron-scheduled workflows. Run by `tim start` daemon |
| `tools/` | Custom JS tools extending TIM's capabilities. Auto-loaded on startup |
| `mcp.json` | MCP (Model Context Protocol) server definitions |

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | this help |
| `/tools` | core, custom, and MCP tools |
| `/mcp` | manage MCP servers |
| `/model [#\|id]` | show or switch model |
| `/agents` | list agents |
| `/agent <name>` | run agent |
| `/workflows` | list workflows |
| `/workflow <name>` | run workflow |
| `/triggers` | scheduled cron triggers |
| `/memory [agent]` | agent memory path/contents |
| `/loc` | lines of code (all) |
| `/sloc` | source lines (no comments/blanks) |
| `/clear` | new session |
| `/compact` | summarize history |
| `/sessions` | saved conversations |
| `/auto` | toggle auto-accept |
| `/plan` | draft without executing |
| `/env` | manage env vars (list/set/unset/email) |
| `/exit` | quit |

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `FIREWORKS_API_KEY` | *(required)* | API key (Fireworks AI) |
| `OPENROUTER_API_KEY` | — | API key (OpenRouter for more models) |
| `TIM_MODEL` | `accounts/fireworks/routers/kimi-k2p5-turbo` | model ID |
| `TIM_CONTEXT_LIMIT` | `128000` | context window (for `/compact` warning) |
| `TAVILY_API_KEY` | — | Web search API |
