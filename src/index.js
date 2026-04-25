#!/usr/bin/env node
// Entry point - parses CLI args, then starts the REPL.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

// Standard tim dir — single root for config, sessions, agents, and any
// user-specific output. Honors $TIM_DIR override, defaults to ~/.tim.
process.env.TIM_DIR ||= path.join(os.homedir(), ".tim");
fs.mkdirSync(process.env.TIM_DIR, { recursive: true });

// Bootstrap global TIM.md if missing (directory conventions, rules)
const globalTimMd = path.join(process.env.TIM_DIR, "TIM.md");
if (!fs.existsSync(globalTimMd)) {
  const defaultTimMd = `# TIM Directory Conventions

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
  fs.writeFileSync(globalTimMd, defaultTimMd);
}

// Bootstrap default agent on first install (minimal tools for coding)
await import("./agents.js").then(({ bootstrapDefaultAgent }) => bootstrapDefaultAgent());

// Load $TIM_DIR/.env into process.env (existing env wins)
try {
  for (const line of fs.readFileSync(path.join(process.env.TIM_DIR, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const val = m[2].replace(/^["'](.*)["']$/, "$1");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
} catch {}

import {
  resumeSession,
  createAgent,
} from "./react.js";
import { loadAgents, writeAgentProfile, agentExists, getAgentsDir, deleteAgentProfile } from "./agents.js";
import { loadWorkflows, writeWorkflow, workflowExists, getWorkflowsDir, deleteWorkflow, mergeProfile } from "./workflows.js";
import { loadSkills, writeSkillProfile, skillExists, getSkillsDir, deleteSkillProfile } from "./skills.js";
import { runCommand } from "./commands.js";
import { load as loadSession, latest } from "./session.js";

import { startRepl } from "./repl.js";
import { loadTriggers, writeTrigger, deleteTrigger, triggerExists, getTriggerState, getTriggersDir, runTrigger } from "./triggers.js";
import { start } from "./server.js";
import { commit as commitHistory } from "./history.js";
import * as ui from "./ui.js";

const ask = (rl, q, def) => new Promise((res) => {
  const hint = def ? ` (${def})` : "";
  rl.question(`  ${q}${hint}: `, (a) => res(a.trim() || def || ""));
});

const openPrompt = async (filepath) => {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question("  Open in editor? (Y/n): ", res));
  rl.close();
  if (!ans.trim() || ans.trim().toLowerCase() !== "n") spawnSync(editor, [filepath], { stdio: "inherit" });
};



const editFile = (filepath) => {
  spawnSync(process.env.EDITOR || process.env.VISUAL || "vi", [filepath], { stdio: "inherit" });
};

const runAndPrint = async (sub, task) => {
  try {
    await sub.turn(task);
    const last = sub.state.messages
      .filter((m) => m.role === "assistant" && !m.tool_calls?.length && m.content).pop();
    if (last?.content) console.log(last.content);
    process.exit(0);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
};

const argv = process.argv.slice(2);

// Headless runs (tim run, --yolo) should auto-accept without prompting.
// Set this BEFORE importing permissions.js so it initializes correctly.
if (argv[0] === "run" || argv.includes("--yolo")) {
  process.env.TIM_AUTO_ACCEPT = "1";
}

// `tim chat` — a general REPL whose session is filed under "general"
// regardless of cwd, so it shows up under Chat in the iOS app instead of
// being grouped with the current project's sessions. Shift the subcommand
// out so the rest of the dispatch treats it as a bare REPL launch.
if (argv[0] === "chat") {
  process.env.TIM_SESSION_FOLDER = "general";
  argv.shift();
}

if (argv.includes("--list")) {
  await runCommand("/sessions");
  process.exit(0);
}

// Check if first arg is an agent name (for `tim <agent>` CLI)
// This must come before the agent subcommand handling
const agents = loadAgents();
const firstArgIsAgent = argv[0] && !argv[0].startsWith("-") && ![
  "agent", "workflow", "trigger", "schedule", "run", "env", "start", "server"
].includes(argv[0]) && agents[argv[0]];

if (firstArgIsAgent) {
  const agentName = argv[0];
  const profile = agents[agentName];

  // Check for attachments (files after --)
  const attachments = { images: [], pdfs: [] };
  let dashDashIdx = argv.indexOf("--");
  if (dashDashIdx !== -1) {
    for (let i = dashDashIdx + 1; i < argv.length; i++) {
      const p = argv[i];
      const ext = p.toLowerCase().slice(p.lastIndexOf("."));
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext))
        attachments.images.push(p);
      else if (ext === ".pdf") attachments.pdfs.push(p);
    }
  }

  // Get optional initial task (args between agent name and -- or end)
  let initialTask = "";
  const startIdx = 1; // after agent name
  const endIdx = dashDashIdx !== -1 ? dashDashIdx : argv.length;
  if (endIdx > startIdx) {
    initialTask = argv.slice(startIdx, endIdx).join(" ").trim();
  }

  // Handle --yolo for auto-accept
  if (argv.includes("--yolo")) {
    process.env.TIM_AUTO_ACCEPT = "1";
  }

  // Handle --resume for session resumption
  const resumeIdx = argv.indexOf("--resume");
  if (resumeIdx !== -1) {
    const id = argv[resumeIdx + 1];
    const data = id ? loadSession(id) : latest();
    if (!data) {
      console.error("no session to resume");
      process.exit(1);
    }
    // Note: resuming with a specific agent means we'll switch to that agent's context
    // The session messages will be kept but agent context will change
  }

  // Start REPL with this agent
  import("./react.js").then(({ createAgent }) => {
    createAgent(profile).then((agent) => {
      // Start REPL with the agent's state already initialized
      import("./repl.js").then(({ startReplWithAgent }) => {
        startReplWithAgent(agent, attachments, initialTask);
      });
    });
  });
  // Don't exit - let the REPL run
  await new Promise(() => {});
}

// tim agent new|list|edit|delete
if (argv[0] === "agent") {
  const sub = argv[1];
  const name = argv[2];

  if (!sub || sub === "list") {
    const agents = Object.values(loadAgents());
    if (!agents.length) {
      console.log("  no agents — run: tim agent new");
    } else {
      const pad = Math.max(...agents.map(a => a.name.length)) + 2;
      console.log();
      for (const a of agents) {
        console.log(`  ${a.name.padEnd(pad)} ${a.description}`);
      }
      console.log();
    }
    process.exit(0);
  }

  if (sub === "new") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log();
    console.log("  Creating a new agent. A memory file will be bootstrapped at $TIM_DIR/memory/<name>.md.\n");

    const agentName = await ask(rl, "Name (kebab-case, e.g. youtube)", name || "");
    if (!agentName) { console.error("  name is required"); process.exit(1); }
    if (agentExists(agentName)) {
      console.error(`  agent "${agentName}" already exists at ${getAgentsDir()}/${agentName}.md`);
      process.exit(1);
    }

    const description = await ask(rl, "What does it do? (one line)", "");
    const toolsInput  = await ask(rl, "Tools (comma-separated, or 'all')", "all");
    const tools       = toolsInput === "all" ? "all" : toolsInput;

    const defaultPrompt =
      `You are the ${agentName} agent.\n\n` +
      `Your memory file (auto-loaded) holds durable context for this domain.\n` +
      `When given a task:\n` +
      `1. Use the memory already in your context — don't re-read it.\n` +
      `2. Dispatch task-shaped work via spawn_workflow.\n` +
      `3. Synthesize results and reply to the user.\n` +
      `4. If you learned something worth keeping across runs, call append_memory.\n`;

    const systemPrompt = await ask(rl, "Brief system prompt (or press enter for a starter template)", "");
    rl.close();

    const filepath = writeAgentProfile(agentName, {
      description, tools,
      systemPrompt: systemPrompt || defaultPrompt,
    });
    commitHistory(`agent new: ${agentName}`);

    console.log();
    console.log(`  ✓ created ${filepath}`);
    await openPrompt(filepath);

    console.log(`\n  Run it: tim run ${agentName} "your task here"`);
    console.log(`  Add a workflow: tim workflow new\n`);
    process.exit(0);
  }

  if (sub === "edit") {
    if (!name) { console.error("usage: tim agent edit <name>"); process.exit(1); }
    const filepath = `${getAgentsDir()}/${name}.md`;
    if (!fs.existsSync(filepath)) { console.error(`agent "${name}" not found`); process.exit(1); }
    editFile(filepath);
    commitHistory(`agent edit: ${name}`);
    console.log(`  ✓ saved ${filepath}`);
    process.exit(0);
  }

  if (sub === "delete") {
    if (!name) { console.error("usage: tim agent delete <name>"); process.exit(1); }
    if (!deleteAgentProfile(name)) { console.error(`agent "${name}" not found`); process.exit(1); }
    commitHistory(`agent delete: ${name}`);
    console.log(`  ✓ deleted ${name}`);
    process.exit(0);
  }

  console.error("usage: tim agent [new|list|edit|delete] [name]");
  process.exit(1);
}

// tim workflow new|list|edit|delete
if (argv[0] === "workflow") {
  const sub = argv[1];
  const name = argv[2];

  if (!sub || sub === "list") {
    const workflows = Object.values(loadWorkflows());
    if (!workflows.length) {
      console.log("  no workflows — run: tim workflow new");
    } else {
      const pad = Math.max(...workflows.map(w => w.name.length)) + 2;
      console.log();
      for (const w of workflows) {
        console.log(`  ${w.name.padEnd(pad)} [agent: ${w.agent}]  ${w.description}`);
      }
      console.log();
    }
    process.exit(0);
  }

  if (sub === "new") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log();
    console.log("  Creating a new workflow (task spec for an agent).\n");

    const workflowName = await ask(rl, "Name (kebab-case, e.g. youtube-daily-report)", name || "");
    if (!workflowName) { console.error("  name is required"); process.exit(1); }
    if (workflowExists(workflowName)) {
      console.error(`  workflow "${workflowName}" already exists at ${getWorkflowsDir()}/${workflowName}.md`);
      process.exit(1);
    }

    const agents = Object.keys(loadAgents());
    if (!agents.length) { console.error("  no agents — run: tim agent new"); process.exit(1); }
    console.log(`  Available agents: ${agents.join(", ")}`);

    const agent = await ask(rl, "Agent that owns this workflow", agents[0]);
    if (!loadAgents()[agent]) { console.error(`  unknown agent: ${agent}`); process.exit(1); }

    const description = await ask(rl, "What does this workflow do? (one line)", "");
    const toolsInput  = await ask(rl, "Tools override (comma-separated, or blank for agent defaults)", "");
    const tools       = toolsInput ? toolsInput.split(",").map(s => s.trim()).filter(Boolean) : null;
    const precheck    = await ask(rl, "Precheck tool (optional — skip run if it returns empty)", "");
    const task        = await ask(rl, "Default task prompt (used when fired without override)", "");
    const systemPrompt = await ask(rl, "System prompt extension (task-specific instructions)", "");
    rl.close();

    const filepath = writeWorkflow(workflowName, { description, agent, task, precheck: precheck || null, tools, systemPrompt });
    commitHistory(`workflow new: ${workflowName}`);

    console.log();
    console.log(`  ✓ created ${filepath}`);
    await openPrompt(filepath);

    console.log(`\n  Run it: tim run ${workflowName} "override task (optional)"\n`);
    process.exit(0);
  }

  if (sub === "edit") {
    if (!name) { console.error("usage: tim workflow edit <name>"); process.exit(1); }
    const filepath = `${getWorkflowsDir()}/${name}.md`;
    if (!fs.existsSync(filepath)) { console.error(`workflow "${name}" not found`); process.exit(1); }
    editFile(filepath);
    commitHistory(`workflow edit: ${name}`);
    console.log(`  ✓ saved ${filepath}`);
    process.exit(0);
  }

  if (sub === "delete") {
    if (!name) { console.error("usage: tim workflow delete <name>"); process.exit(1); }
    if (!deleteWorkflow(name)) { console.error(`workflow "${name}" not found`); process.exit(1); }
    commitHistory(`workflow delete: ${name}`);
    console.log(`  ✓ deleted ${name}`);
    process.exit(0);
  }

  console.error("usage: tim workflow [new|list|edit|delete] [name]");
  process.exit(1);
}

// tim skill new|list|edit|delete
// Skills are reusable procedural recipes — any agent can consult one via
// read_skill(name) when a task matches the skill's description. Managed
// the same way as agents and workflows (same frontmatter+body format).
if (argv[0] === "skill") {
  const sub = argv[1];
  const name = argv[2];

  if (!sub || sub === "list") {
    const skills = Object.values(loadSkills());
    if (!skills.length) {
      console.log("  no skills — run: tim skill new  (or ask an agent to `create_skill` in chat)");
    } else {
      const pad = Math.max(...skills.map((s) => s.name.length)) + 2;
      console.log();
      for (const s of skills) {
        console.log(`  ${s.name.padEnd(pad)} ${s.description}`);
      }
      console.log();
    }
    process.exit(0);
  }

  if (sub === "new") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log();
    console.log("  Creating a new skill (reusable procedural recipe — any agent can consult it).\n");

    const skillName = await ask(rl, "Name (kebab-case, e.g. deploy-nextjs-vercel)", name || "");
    if (!skillName) { console.error("  name is required"); process.exit(1); }
    if (skillExists(skillName)) {
      console.error(`  skill "${skillName}" already exists at ${getSkillsDir()}/${skillName}.md`);
      process.exit(1);
    }

    const description = await ask(
      rl,
      "Description (action-oriented; this is what the model sees to decide relevance)",
      "",
    );
    if (!description) { console.error("  description is required — the model uses it to decide when to consult the skill"); process.exit(1); }

    const starterBody =
      `## When to use\n` +
      `Describe the conditions that make this skill relevant.\n\n` +
      `## Steps\n` +
      `1. First concrete step.\n` +
      `2. Next step.\n\n` +
      `## Verification\n` +
      `How to confirm the procedure worked.\n\n` +
      `## Gotchas\n` +
      `Known pitfalls, env assumptions, or edge cases.\n`;

    rl.close();
    const filepath = writeSkillProfile(skillName, { description, body: starterBody });
    commitHistory(`skill new: ${skillName}`);

    console.log();
    console.log(`  ✓ created ${filepath}`);
    await openPrompt(filepath);

    console.log(`\n  Available to every agent. Narrow per agent with \`skills: [${skillName}]\` in the agent's frontmatter.\n`);
    process.exit(0);
  }

  if (sub === "edit") {
    if (!name) { console.error("usage: tim skill edit <name>"); process.exit(1); }
    const filepath = `${getSkillsDir()}/${name}.md`;
    if (!fs.existsSync(filepath)) { console.error(`skill "${name}" not found`); process.exit(1); }
    editFile(filepath);
    commitHistory(`skill edit: ${name}`);
    console.log(`  ✓ saved ${filepath}`);
    process.exit(0);
  }

  if (sub === "delete") {
    if (!name) { console.error("usage: tim skill delete <name>"); process.exit(1); }
    if (!deleteSkillProfile(name)) { console.error(`skill "${name}" not found`); process.exit(1); }
    commitHistory(`skill delete: ${name}`);
    console.log(`  ✓ deleted ${name}`);
    process.exit(0);
  }

  console.error("usage: tim skill [new|list|edit|delete] [name]");
  process.exit(1);
}

// tim env — feature status: which env vars are set, what's missing, what unlocks what.
if (argv[0] === "env") {
  const has = (k) => !!process.env[k] && process.env[k].length > 0;
  const group = (label, req, opt = []) => ({ label, req, opt });

  const features = [
    group("Web search",       ["TAVILY_API_KEY"]),
    group("Image generation", ["OPENROUTER_API_KEY"]),
    group("YouTube Data API (used by youtube-daily agent)",
      ["YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID"]),
  ];

  const missingAll = [];
  console.log();
  console.log("  Feature status:");
  console.log();
  for (const f of features) {
    const missingReq = f.req.filter((k) => !has(k));
    const missingOpt = f.opt.filter((k) => !has(k));
    const symbol = missingReq.length === 0 ? "✓" : "✗";
    console.log(`  ${symbol} ${f.label}`);
    for (const k of f.req) {
      console.log(`      ${has(k) ? "•" : "✗"} ${k}${has(k) ? "" : "   (required)"}`);
    }
    for (const k of f.opt) {
      console.log(`      ${has(k) ? "•" : "·"} ${k}${has(k) ? "" : "   (optional)"}`);
    }
    if (missingReq.length) missingAll.push(...missingReq);
    console.log();
  }

  if (missingAll.length) {
    console.log(`  Missing required: ${missingAll.join(", ")}`);
  } else {
    console.log(`  All core features configured.`);
  }
  console.log();
  console.log(`  Set vars: edit ${process.env.TIM_DIR}/.env  or run tim, then: /env set KEY=value`);
  console.log();
  process.exit(0);
}

// tim start / tim server — long-running scheduler + optional HTTP/WebSocket server
// Both commands do the same thing. Use --tailscale to expose on your Tailscale IP.
// Server auto-restarts if it crashes (up to 10 attempts).
//
// Examples:
//   tim start              # Scheduler only, local (auto-restarts on crash)
//   tim start --tailscale  # Scheduler + server on Tailscale IP
//   tim server             # Same as tim start
//   tim server --tailscale # Same as tim start --tailscale
if (argv[0] === "start" || argv[0] === "server") {
  const tailscale = argv.includes("--tailscale");
  await start({ tailscale });
}

// tim trigger list|add|remove|run
if (argv[0] === "trigger" || argv[0] === "schedule") {
  const sub = argv[1];

  if (!sub || sub === "list") {
    const triggers = loadTriggers();
    if (!triggers.length) {
      console.log("  no triggers — run: tim trigger add <name>");
    } else {
      const pad = Math.max(...triggers.map((t) => t.name.length)) + 2;
      console.log();
      for (const t of triggers) {
        const state = getTriggerState(t.name);
        const last = state?.lastRunAt
          ? `  last: ${state.lastRunAt.slice(0, 16).replace("T", " ")} [${state.lastStatus}]`
          : "";
        const disabled = t.enabled ? "" : " (disabled)";
        console.log(`  ${t.name.padEnd(pad)} ${t.schedule.padEnd(14)} → ${t.workflow}${disabled}${last}`);
      }
      console.log();
    }
    process.exit(0);
  }

  if (sub === "add") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log();
    console.log("  Creating a new scheduled trigger.\n");

    const name = await ask(rl, "Name (kebab-case, e.g. morning-digest)", argv[2] || "");
    if (!name) { console.error("  name is required"); process.exit(1); }
    if (triggerExists(name)) {
      console.error(`  trigger "${name}" already exists at ${getTriggersDir()}/${name}.md`);
      process.exit(1);
    }

    const workflows = Object.keys(loadWorkflows());
    if (!workflows.length) { console.error("  no workflows — run: tim workflow new"); process.exit(1); }

    console.log(`  Available workflows: ${workflows.join(", ")}`);
    const workflow = await ask(rl, "Workflow to run", workflows[0]);
    if (!loadWorkflows()[workflow]) { console.error(`  unknown workflow: ${workflow}`); process.exit(1); }

    console.log(`  Cron examples: "0 7 * * *" (7am daily), "*/5 * * * *" (every 5min), "0 9 * * 1-5" (9am weekdays)`);
    const schedule = await ask(rl, "Schedule (cron expression)", "0 7 * * *");
    const task = await ask(rl, "Task override (blank = use workflow's default task)", "");
    const description = await ask(rl, "Description (optional)", "");
    rl.close();

    const filepath = writeTrigger(name, { schedule, workflow, task, description });
    commitHistory(`trigger add: ${name}`);
    console.log();
    console.log(`  ✓ created ${filepath}`);
    console.log(`\n  Test it: tim trigger run ${name}`);
    console.log(`  Start scheduler: tim start\n`);
    process.exit(0);
  }

  if (sub === "remove") {
    const name = argv[2];
    if (!name) { console.error("usage: tim trigger remove <name>"); process.exit(1); }
    if (!deleteTrigger(name)) { console.error(`trigger "${name}" not found`); process.exit(1); }
    commitHistory(`trigger remove: ${name}`);
    console.log(`  ✓ deleted ${name}`);
    process.exit(0);
  }

  if (sub === "run") {
    const name = argv[2];
    if (!name) { console.error("usage: tim trigger run <name>"); process.exit(1); }
    try {
      await runTrigger(name);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error("usage: tim trigger [list|add|remove|run] [name]");
  process.exit(1);
}

// Headless: `tim run <workflow|agent> "<task>"` — if the name matches a workflow,
// run it with the task as override (or its default task). Otherwise treat the
// name as an agent and pass the task through directly.
if (argv[0] === "run") {
  const name = argv[1];
  const taskArg = argv.slice(2).join(" ").trim();
  if (!name) {
    console.error('usage: tim run <workflow|agent> "<task>"');
    process.exit(1);
  }

  const workflow = loadWorkflows()[name];
  if (workflow) {
    const agent = loadAgents()[workflow.agent];
    if (!agent) { console.error(`agent "${workflow.agent}" not found`); process.exit(1); }
    const task = taskArg || workflow.task || `Run the ${workflow.name} workflow.`;
    await runAndPrint(await createAgent(mergeProfile(agent, workflow)), task);
  }

  const profile = loadAgents()[name];
  if (!profile) {
    console.error(`unknown workflow or agent: ${name}`);
    process.exit(1);
  }
  if (!taskArg) {
    console.error(`usage: tim run ${name} "<task>"`);
    process.exit(1);
  }
  await runAndPrint(await createAgent(profile), taskArg);
}

if (argv.includes("--yolo")) {
  ui.info("⚠ auto-accept ON (--yolo) — edits and bash run without prompting");
}

const resumeIdx = argv.indexOf("--resume");
if (resumeIdx !== -1) {
  const id = argv[resumeIdx + 1];
  const data = id ? loadSession(id) : latest();
  if (!data) {
    console.error("no session to resume");
    process.exit(1);
  }
  resumeSession(data);
  ui.success(`resumed ${data.id} (${(data.messages || []).length} messages)`);
}

// Only start REPL if not running a subcommand
if (!argv[0] || !["agent", "workflow", "trigger", "schedule", "run", "env", "start", "server"].includes(argv[0])) {
  startRepl();
}
