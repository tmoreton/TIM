#!/usr/bin/env node
import readline from "node:readline";
import {
  agentTurn,
  getModel,
  Interrupted,
  resumeSession,
  getSessionId,
} from "./agent.js";
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

process.on("SIGINT", () => {
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
  rl.prompt();
});

let buffer = [];
let inHeredoc = false;
const flushBuffer = () => {
  const joined = buffer.join("\n");
  buffer = [];
  return joined.trim();
};

ui.banner(getModel(), process.cwd());
rl.prompt();

rl.on("line", async (line) => {
  if (inHeredoc) {
    if (line.trim() === '"""') {
      inHeredoc = false;
      const input = flushBuffer();
      if (input) await handle(input);
      else rl.prompt();
      return;
    }
    buffer.push(line);
    return;
  }

  if (line.trim() === '"""') {
    inHeredoc = true;
    return;
  }

  if (line.endsWith("\\")) {
    buffer.push(line.slice(0, -1));
    return;
  }

  buffer.push(line);
  const input = flushBuffer();

  if (!input) return rl.prompt();
  if (input === "exit" || input === "quit") {
    ui.exitHint(getSessionId());
    process.exit(0);
  }
  if (isCommand(input)) {
    await runCommand(input);
    return rl.prompt();
  }
  await handle(input);
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
    rl.prompt();
  }
}
