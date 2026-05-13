// First-launch bootstrap: ensures $TIM_DIR exists with conventions doc and a
// default agent, then loads $TIM_DIR/.env into process.env.
// Idempotent — safe to call from any entry point (CLI or server) on startup.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bootstrapDefaultAgent } from "./agents.js";

const DEFAULT_TIM_MD = `# TIM Directory Conventions

**Never create loose files in \`$TIM_DIR\` root.** Everything belongs in a subdirectory.

## Directory Structure

| Folder | Purpose |
|--------|---------|
| \`agents/\` | Agent persona definitions (managed via \`create_agent\` / \`tim agent new\`) |
| \`workflows/\` | Workflow task specs (managed via \`create_workflow\` / \`tim workflow new\`) |
| \`skills/\` | Reusable procedural recipes (managed via \`create_skill\` / \`tim skill new\`) — any agent can consult one via \`read_skill(name)\` when a task matches its description |

## Agents vs workflows vs skills

One agent per domain (\`youtube\`, \`github\`); workflows are tasks within
that domain (\`youtube-daily-report\`, \`youtube-thumbnail-gen\`). If a
\`<domain>\` agent already exists, "<domain> <verb-er>" requests are workflows
under it — not new agents.

Skills are orthogonal: they're "how to do X" recipes any agent can consult.
An agent (or workflow) can narrow visible skills with \`skills: [name, ...]\`
in its frontmatter; omit to see all.

| \`triggers/\` | Cron-scheduled workflows |
| \`memory/\` | Persistent memory per agent (write via \`append_memory\` / \`update_memory\`) |
| \`sessions/\` | Auto-logged conversation sessions |
| \`output/\` | All agent-generated artifacts (see rules below) |

## Output rules

Anything you (the agent) create — reports, drafts, JSON data, images, helper
scripts — lives under \`output/<your-agent-name>/\`. Pick a kebab-case subfolder
that describes the kind of artifact (\`reports/\`, \`thumbnails/\`, \`drafts/\`,
\`scripts/\`, etc.) so the user can browse what you've made over time. For a
one-off task that doesn't fit an existing subfolder, use a task-slug subfolder:
\`output/<agent>/<task-slug>/\`.

If you're running without a named agent (bare REPL or \`tim chat\`), use
\`output/general/...\` instead.

Screenshots from \`capture_webpage\` and \`capture_desktop\` already save to
\`output/<agent>/images/\` automatically — don't duplicate them elsewhere.

## Reusable scripts

Helper code you write for yourself (a YouTube analytics fetcher, an OAuth
setup flow, a transcript parser) goes under \`output/<your-agent-name>/scripts/\`.
Default to Node.js (matches the codebase, no extra runtime). **Before writing
any new script, \`list_files\` on \`output/<your-agent-name>/scripts/\` to see
what already exists** — extend or reuse instead of recreating.

Every script needs a header comment so the user can trace what made it:

\`\`\`js
// Purpose: Fetch yesterday's YouTube channel analytics
// Usage: node fetch_analytics.js [date]
// Env: YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID
// Created by: youtube agent (workflow: daily-report)
\`\`\`

## Memory

Never write to \`memory/\` with \`write_file\` or \`bash\`. Use the memory tools
(\`append_memory\`, \`update_memory\`).
`;

export async function bootstrapTimDir() {
  process.env.TIM_DIR ||= path.join(os.homedir(), ".tim");
  fs.mkdirSync(process.env.TIM_DIR, { recursive: true });

  const globalTimMd = path.join(process.env.TIM_DIR, "TIM.md");
  if (!fs.existsSync(globalTimMd)) {
    fs.writeFileSync(globalTimMd, DEFAULT_TIM_MD);
  }

  await bootstrapDefaultAgent();

  try {
    for (const line of fs.readFileSync(path.join(process.env.TIM_DIR, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const val = m[2].replace(/^["'](.*)["']$/, "$1");
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {}
}
