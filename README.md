```
████████╗ ██╗ ███╗   ███╗
╚══██╔══╝ ██║ ████╗ ████║
   ██║    ██║ ██║╚██╔╝██║
   ██║    ██║ ██║ ╚═╝ ██║
   ╚═╝    ╚═╝ ╚═╝     ╚═╝
```
![alt text](tim.svg)

*the minimalist coding companion*

**~4,995 source lines of JavaScript · ZERO runtime dependencies**

A minimal, single-developer clone of Claude Code. Runs locally, talks to the Fireworks AI API (Kimi K2.5 Turbo), gives the model file + shell tools, and wraps it in a ReAct loop.

The whole point is to be readable—small enough to understand end-to-end.

---

## Install

```bash
git clone https://github.com/tmoreton/TIM.git && cd TIM
npm link # installs the `tim` binary globally

tim /env set FIREWORKS_API_KEY=...
tim /env set OPENROUTER_API_KEY=...
tim /env set TAVILY_API_KEY=...
tim /env set AGENTMAIL_API_KEY=...
tim /env set AGENTMAIL_INBOX_ID=...
tim /env set AGENTMAIL_WHITELIST=...
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
| `spawn_swarm` | run multiple agents in parallel with shared scratchpad |
| `web_fetch` | fetch and extract web pages |
| `web_search` | web search via Tavily (requires `TAVILY_API_KEY`) |
| `update_memory` | overwrite agent memory file |
| `append_memory` | append to agent memory file |
| `notify_email` | send email (AgentMail or SMTP) |
| `receive_email` | poll inbox for new emails (AgentMail) |
| `create_email_inbox` | create new AgentMail inbox |
| `generate_image` | generate images via OpenRouter (requires `OPENROUTER_API_KEY`) |

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
├── smtp.js           # SMTP fallback for email when AgentMail unavailable
├── paths.js          # TIM_SOURCE_ROOT + path helpers
└── tools/
    ├── index.js      # Tool registry: core + custom + MCP merge
    ├── fs.js         # list_files, read_file, edit_file, write_file
    ├── bash.js       # shell command execution with timeout
    ├── search.js     # grep and glob search
    ├── spawn.js      # spawn_workflow: run sub-agents headlessly
    ├── swarm.js      # spawn_swarm: parallel agents with shared scratchpad
    ├── web_fetch.js  # fetch + extract web pages
    ├── web_search.js # Tavily web search
    ├── email.js      # notify_email, receive_email, create_email_inbox
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
| `AGENTMAIL_API_KEY` | — | Email send/receive |
| `AGENTMAIL_INBOX_ID` | — | Default inbox for receiving |
| `AGENTMAIL_WHITELIST` | — | Allowed sender emails/domains (required)
