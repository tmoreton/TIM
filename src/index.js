#!/usr/bin/env node
// Entry point - parses CLI args, sets up the REPL, handles Ctrl+C interrupt.
// Delegates commands to commands.js, chat to agent.js.

import readline from "node:readline";
import {
  agentTurn,
  getModel,
  resumeSession,
  getSessionId,
} from "./agent.js";
import { Interrupted } from "./streaming.js";
import { isCommand, runCommand } from "./commands.js";
import { load as loadSession, latest } from "./session.js";
import { setReadline, setAutoAccept } from "./permissions.js";
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

// --- REPL ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: ui.prompt(),
});
setReadline(rl);

let currentAbort = null;
let lastSigintAt = 0;

const handleSigint = () => {
  if (currentAbort && !currentAbort.signal.aborted) {
    currentAbort.abort();
    return;
  }
  const now = Date.now();
  if (now - lastSigintAt < 1500) {
    console.log();
    ui.info("bye.");
    ui.exitHint(getSessionId());
    process.exit(0);
  }
  lastSigintAt = now;
  console.log();
  ui.info("press Ctrl+C again to exit");
  safePrompt();
};

// readline auto-closes on SIGINT unless the interface has its own listener —
// register on both so Ctrl+C mid-stream doesn't kill the REPL.
process.on("SIGINT", handleSigint);
rl.on("SIGINT", handleSigint);
rl.on("close", () => process.exit(0));

const safePrompt = () => {
  if (!rl.closed) rl.prompt();
};

let buffer = [];
let inHeredoc = false;
let flushTimer = null;
const FLUSH_DELAY_MS = 50; // debounce for paste detection

const flushBuffer = () => {
  const joined = buffer.join("\n");
  buffer = [];
  return joined.trim();
};

const processInput = async () => {
  const input = flushBuffer();
  if (!input) return safePrompt();
  if (input === "exit" || input === "quit") {
    ui.exitHint(getSessionId());
    process.exit(0);
  }
  if (isCommand(input)) {
    await runCommand(input);
    return safePrompt();
  }
  await handle(input);
};

ui.banner(getModel(), process.cwd());
safePrompt();

rl.on("line", async (line) => {
  // heredoc mode: collect until closing """
  if (inHeredoc) {
    if (line.trim() === '"""') {
      inHeredoc = false;
      const input = flushBuffer();
      if (input) await handle(input);
      else safePrompt();
      return;
    }
    buffer.push(line);
    return;
  }

  // entering heredoc mode
  if (line.trim() === '"""') {
    inHeredoc = true;
    return;
  }

  // explicit line continuation with backslash
  if (line.endsWith("\\")) {
    buffer.push(line.slice(0, -1));
    return;
  }

  buffer.push(line);

  // debounced flush: if more lines arrive quickly (paste), we wait
  clearTimeout(flushTimer);
  flushTimer = setTimeout(processInput, FLUSH_DELAY_MS);
});

async function handle(input) {
  currentAbort = new AbortController();
  try {
    await agentTurn(input, currentAbort.signal);
  } catch (e) {
    if (e instanceof Interrupted || e?.name === "AbortError") {
      console.log();
      ui.info("interrupted");
      console.log();
    } else {
      ui.error(e.message);
    }
  } finally {
    currentAbort = null;
    safePrompt();
  }
}
