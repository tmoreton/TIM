#!/usr/bin/env node
// Entry point - parses CLI args, then starts the REPL.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Load ~/.tim/.env into process.env (existing env wins)
const envPath = path.join(os.homedir(), ".tim", ".env");
try {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const val = m[2].replace(/^["'](.*)["']$/, "$1");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
} catch {}

import {
  resumeSession,
} from "./agent.js";
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
