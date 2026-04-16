#!/usr/bin/env node
// Entry point - parses CLI args, then starts the REPL.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Standard tim dir — single root for config, sessions, agents, and any
// user-specific output. Honors $TIM_DIR override, defaults to ~/.tim.
process.env.TIM_DIR ||= path.join(os.homedir(), ".tim");
fs.mkdirSync(process.env.TIM_DIR, { recursive: true });

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
import { runCommand } from "./commands.js";
import { load as loadSession, latest } from "./session.js";
import { setAutoAccept } from "./permissions.js";
import { startRepl } from "./repl.js";
import * as ui from "./ui.js";

// --- argv handling ---
const argv = process.argv.slice(2);

if (argv.includes("--list")) {
  await runCommand("/sessions");
  process.exit(0);
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
        const role = a.role === "director" ? " [director]" : " [worker]";
        const prod = a.produces ? ` → ${a.produces.domain}/${a.produces.name}` : "";
        console.log(`  ${a.name.padEnd(pad)} ${role}${prod}  ${a.description}`);
      }
      console.log();
    }
    process.exit(0);
  }

  if (sub === "new") {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q, def) => new Promise(res => {
      const hint = def ? ` (${def})` : "";
      rl.question(`  ${q}${hint}: `, ans => res(ans.trim() || def || ""));
    });

    console.log();
    console.log("  Creating a new agent profile.\n");

    const agentName   = await ask("Name (kebab-case, e.g. youtube-shorts)", name || "");
    if (!agentName) { console.error("  name is required"); process.exit(1); }
    if (agentExists(agentName)) {
      console.error(`  agent "${agentName}" already exists at ${getAgentsDir()}/${agentName}.md`);
      process.exit(1);
    }

    const description = await ask("What does it do? (one line)", "");
    const roleInput   = await ask("Role — director (orchestrates) or worker (single task)", "worker");
    const role        = roleInput.startsWith("d") ? "director" : "worker";
    const domain      = await ask("Knowledge domain (e.g. youtube, twitter, user — or leave blank)", "");
    let produces      = "";
    if (role === "worker") {
      produces = await ask(`Produces knowledge? (e.g. ${domain || "youtube"}/research-{date} — or leave blank)`, "");
    }
    const toolsInput  = await ask("Tools (comma-separated, or 'all')", "all");
    const tools       = toolsInput === "all" ? "all" : toolsInput;

    const defaultPrompt = role === "director"
      ? `You are a ${agentName} director agent.\n\nWhen given a task:\n1. Read relevant knowledge.\n2. Dispatch workers via spawn_agent.\n3. Read back knowledgeRefs from workers.\n4. Synthesize and deliver results.\n`
      : `You are a ${agentName} worker agent.\n\nGiven a task, complete it and return a concise markdown summary.\nYour output will be written to knowledge automatically — do not call write_knowledge yourself.\n`;

    const systemPrompt = await ask("Brief system prompt (or press enter for a starter template)", defaultPrompt);

    rl.close();

    const filepath = writeAgentProfile(agentName, {
      role, description, domain, produces, tools,
      systemPrompt: systemPrompt || defaultPrompt,
    });

    console.log();
    console.log(`  ✓ created ${filepath}`);

    const { spawnSync } = await import("node:child_process");
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (editor) {
      const { default: readline2 } = await import("node:readline");
      const rl2 = readline2.createInterface({ input: process.stdin, output: process.stdout });
      const openIt = await new Promise(res => rl2.question("  Open in editor? (Y/n): ", ans => { rl2.close(); res(!ans.trim() || ans.trim().toLowerCase() !== "n"); }));
      if (openIt) spawnSync(editor, [filepath], { stdio: "inherit" });
    }

    console.log(`\n  Run it: tim run ${agentName} "your task here"\n`);
    process.exit(0);
  }

  if (sub === "edit") {
    if (!name) { console.error("usage: tim agent edit <name>"); process.exit(1); }
    const filepath = `${getAgentsDir()}/${name}.md`;
    if (!fs.existsSync(filepath)) { console.error(`agent "${name}" not found`); process.exit(1); }
    const { spawnSync } = await import("node:child_process");
    spawnSync(process.env.EDITOR || process.env.VISUAL || "vi", [filepath], { stdio: "inherit" });
    console.log(`  ✓ saved ${filepath}`);
    process.exit(0);
  }

  if (sub === "delete") {
    if (!name) { console.error("usage: tim agent delete <name>"); process.exit(1); }
    if (!deleteAgentProfile(name)) { console.error(`agent "${name}" not found`); process.exit(1); }
    console.log(`  ✓ deleted ${name}`);
    process.exit(0);
  }

  console.error("usage: tim agent [new|list|edit|delete] [name]");
  process.exit(1);
}

// Headless: `tim run <agent> "<task>"` — run a profile to completion and exit.
if (argv[0] === "run") {
  const name = argv[1];
  const task = argv.slice(2).join(" ").trim();
  if (!name || !task) {
    console.error('usage: tim run <agent> "<task>"');
    process.exit(1);
  }
  const profile = loadAgents()[name];
  if (!profile) {
    console.error(`unknown agent: ${name}`);
    process.exit(1);
  }
  setAutoAccept(true); // headless: no interactive prompts
  const agent = await createAgent(profile);
  try {
    await agent.turn(task);
    const last = agent.state.messages
      .filter((m) => m.role === "assistant" && !m.tool_calls?.length && m.content)
      .pop();
    if (last?.content) console.log(last.content);
    process.exit(0);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

if (argv.includes("--yolo")) {
  setAutoAccept(true);
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

// Start the REPL
startRepl();
