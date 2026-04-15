#!/usr/bin/env node
import readline from "node:readline";
import {
  agentTurn,
  getModel,
  Interrupted,
  resumeSession,
} from "./agent.js";
import { isCommand, runCommand } from "./commands.js";
import { list as listSessions, load as loadSession, latest } from "./session.js";
import { setReadline } from "./permissions.js";

// --- argv handling ---
const argv = process.argv.slice(2);
if (argv.includes("--list")) {
  const all = listSessions();
  if (!all.length) console.log("(no sessions)");
  for (const s of all) {
    const when = new Date(s.updatedAt).toISOString().replace("T", " ").slice(0, 19);
    console.log(`${s.id}  [${s.turns} turns]  ${when}  ${s.cwd}`);
  }
  process.exit(0);
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
  console.log(`resumed ${data.id} (${(data.messages || []).length} messages)`);
}

// --- REPL ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "you> ",
});
setReadline(rl);

let currentAbort = null;
let lastSigintAt = 0;

process.on("SIGINT", () => {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
    return;
  }
  const now = Date.now();
  if (now - lastSigintAt < 1500) {
    console.log("\nbye.");
    process.exit(0);
  }
  lastSigintAt = now;
  console.log("\n(press Ctrl+C again to exit)");
  rl.prompt();
});

let buffer = [];
let inHeredoc = false;
const flushBuffer = () => {
  const joined = buffer.join("\n");
  buffer = [];
  return joined.trim();
};

console.log(
  `tim (${getModel()}) in ${process.cwd()}
Type /help for commands. End a line with \\ to continue; """ toggles a multi-line block.
`,
);
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
  if (input === "exit" || input === "quit") process.exit(0);
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
      console.log("\n(interrupted)\n");
    } else {
      console.error(`error: ${e.message}`);
    }
  } finally {
    currentAbort = null;
    rl.prompt();
  }
}
