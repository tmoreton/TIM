```
████████╗ ██╗ ███╗   ███╗
╚══██╔══╝ ██║ ████╗ ████║
   ██║    ██║ ██║╚██╔╝██║
   ██║    ██║ ██║ ╚═╝ ██║
   ╚═╝    ╚═╝ ╚═╝     ╚═╝
```

*the minimalist coding companion*

**~4,210 source lines of JavaScript · ZERO runtime dependencies**

A minimal, single-developer clone of Claude Code. Runs locally, talks to the Fireworks AI API (Kimi K2.5 Turbo), gives the model file + shell tools, and wraps it in a ReAct loop.

The whole point is to be readable—small enough to understand end-to-end.

---

## Install

```bash
git clone <this-repo> TIM && cd TIM
npm install
npm link

tim
tim /env set FIREWORKS_API_KEY=...
tim /env set OPENROUTER_API_KEY=...
```

## How It Works

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
| `notify_email` | send email (AgentMail or SMTP) |
| `receive_email` | poll inbox for new emails (AgentMail) |
| `create_email_inbox` | create new AgentMail inbox |
| `generate_image` | generate images via OpenRouter (requires `OPENROUTER_API_KEY`) |

**Custom Tools**: Drop a `.js` file in `~/.tim/tools/` that exports `schema` + `run`:

```javascript
// ~/.tim/tools/my_api.js
export const schema = {
  type: "function",
  function: {
    name: "my_api",
    description: "Call my API",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  }
};

export async function run({ query }) {
  return "Hello " + query;
}

// Optional: gate on env var
export const requiredEnv = "MY_API_KEY";
```

**Permissions**: Destructive ops (`edit_file`, `write_file`, `bash`) prompt for confirmation. `[a]lways` allowlists for the session. `/yolo` toggles auto-accept.

**Context**: Loads `~/.tim/TIM.md` (global) and `./TIM.md` (project) into the system prompt.

**Sessions**: Auto-saved to `~/.tim/sessions/`. Resume with `tim --resume [id]`.

---

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
    ├── web_fetch.js  # fetch + extract web pages
    ├── web_search.js # Tavily web search
    ├── email.js      # notify_email, receive_email, create_email_inbox
    ├── memory.js     # update_memory, append_memory
    └── custom.js     # Load custom tools from .tim/tools/*.js
```

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

---

## Image & PDF Input

Drag and drop files or paste paths:

```
you> /Users/me/screenshot.png what does this show?
     attached: screenshot.png
```
