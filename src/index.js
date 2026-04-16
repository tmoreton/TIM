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
} from "./agent.js";
import { runCommand } from "./commands.js";
import { load as loadSession, latest } from "./session.js";
import { loadAgents } from "./agents.js";
import { setAutoAccept } from "./permissions.js";
import { startRepl } from "./repl.js";
import * as ui from "./ui.js";

// --- argv handling ---
const argv = process.argv.slice(2);

if (argv.includes("--list")) {
  await runCommand("/sessions");
  process.exit(0);
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
