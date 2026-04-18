// REPL interface - handles user input, multi-line mode, and dispatches to agent.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { agentTurn, getModel, getSessionId, resetMessages, resumeSession } from "./react.js";
import { Interrupted } from "./llm.js";
import { isCommand, runCommand } from "./commands.js";
import { setReadline, isAutoAccept } from "./permissions.js";
import * as ui from "./ui.js";


const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PDF_EXT = ".pdf";

// Resolve a candidate path string (handles ~ and shell-escaped spaces).
const resolvePath = (raw) => {
  const unescaped = raw.replace(/\\(.)/g, "$1");
  if (unescaped.startsWith("~"))
    return path.join(os.homedir(), unescaped.slice(1));
  return path.resolve(unescaped);
};

// Walks back from each image/pdf extension to the nearest path-start
// (`/`, `~`, `./`, `../`) and picks the longest prefix that exists on disk.
// This handles unquoted paths with spaces like screenshot filenames.
const extractAttachments = (text) => {
  const images = [];
  const pdfs = [];
  const ranges = [];
  const seen = new Set();

  const extRegex = /\.(png|jpg|jpeg|gif|webp|bmp|pdf)\b/gi;
  let m;
  while ((m = extRegex.exec(text)) !== null) {
    const extEnd = m.index + m[0].length;

    // Candidate path starts: `/`, `~`, `./`, `../` at start of input or after whitespace/quote.
    const starts = [];
    const startRegex = /(?:^|[\s"'])((?:[/~]|\.{1,2}\/))/g;
    let sm;
    while ((sm = startRegex.exec(text)) !== null) {
      const s = sm.index + sm[0].length - sm[1].length;
      if (s < extEnd) starts.push(s);
    }
    starts.sort((a, b) => a - b); // longest match first

    for (const s of starts) {
      const raw = text.slice(s, extEnd).replace(/^["']|["']$/g, "");
      const resolved = resolvePath(raw);
      try {
        if (!fs.statSync(resolved).isFile()) continue;
      } catch {
        continue;
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        const ext = path.extname(resolved).toLowerCase();
        if (IMAGE_EXTS.has(ext)) images.push(resolved);
        else if (ext === PDF_EXT) pdfs.push(resolved);
      }
      ranges.push([s, extEnd]);
      break;
    }
  }

  let cleaned = text;
  for (const [s, e] of ranges.sort((a, b) => b[0] - a[0]))
    cleaned = cleaned.slice(0, s) + " " + cleaned.slice(e);
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return { text: cleaned, images, pdfs };
};


let rl = null;
let currentAbort = null;
let lastSigintAt = 0;

let buffer = [];
let inHeredoc = false;
let flushTimer = null;
const FLUSH_DELAY_MS = 300; // debounce for paste detection (allow multi-line paste)

// Inputs typed while a turn is running land here and drain FIFO when idle.
const inputQueue = [];
const previewInput = (s) =>
  (s.length > 60 ? s.slice(0, 57) + "..." : s).replace(/\n/g, " ");

let currentAgentName = null; // Set when starting REPL with a specific agent

const flushBuffer = () => {
  const joined = buffer.join("\n");
  buffer = [];
  return joined.trim();
};

const safePrompt = () => {
  if (!rl || rl.closed) return;
  // Update prompt to show agent name if in agent mode
  rl.setPrompt(currentAgentName ? ui.agentPrompt(currentAgentName) : ui.prompt());
  rl.prompt();
};


const processInput = async (initialAttachments = null) => {
  const rawInput = flushBuffer();
  if (!rawInput) return safePrompt();
  await processRaw(rawInput, initialAttachments);
};

const processRaw = async (rawInput, initialAttachments = null) => {
  // If a turn is in progress, park the raw input for after it finishes.
  if (currentAbort) {
    inputQueue.push({ rawInput, initialAttachments });
    ui.info(`queued (${inputQueue.length}): ${previewInput(rawInput)}`);
    return;
  }

  // Extract any image/pdf paths from the input
  const { text: input, images, pdfs } = extractAttachments(rawInput);

  // Merge with any attachments from CLI args
  const allAttachments = {
    images: [...(initialAttachments?.images || []), ...images],
    pdfs: [...(initialAttachments?.pdfs || []), ...pdfs],
  };

  if (input === "exit" || input === "quit") {
    ui.exitHint(await getSessionId());
    process.exit(0);
  }
  if (isCommand(input)) {
    await runCommand(input);
    return drainOrPrompt();
  }

  // Show detected attachments
  if (allAttachments.images.length || allAttachments.pdfs.length) {
    const all = [...allAttachments.images, ...allAttachments.pdfs].map(p => path.basename(p));
    ui.info(`attached: ${all.join(", ")}`);
  }

  await handle(input, allAttachments);
};

const drainOrPrompt = async () => {
  if (inputQueue.length) {
    const { rawInput, initialAttachments } = inputQueue.shift();
    await processRaw(rawInput, initialAttachments);
  } else {
    safePrompt();
  }
};

const handle = async (input, attachments) => {
  currentAbort = new AbortController();
  try {
    await agentTurn(input, currentAbort.signal, attachments);
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
    await drainOrPrompt();
  }
};


const handleSigint = async () => {
  if (currentAbort && !currentAbort.signal.aborted) {
    currentAbort.abort();
    if (inputQueue.length) {
      const n = inputQueue.length;
      inputQueue.length = 0;
      ui.info(`cleared ${n} queued`);
    }
    return;
  }
  const now = Date.now();
  if (now - lastSigintAt < 1500) {
    console.log();
    ui.info("bye.");
    ui.exitHint(await getSessionId());
    process.exit(0);
  }
  lastSigintAt = now;
  console.log();
  ui.info("press Ctrl+C again to exit");
  safePrompt();
};

const setupLineHandler = (initialAttachments) => {
  rl.on("line", async (line) => {
    // heredoc mode: collect until closing """
    if (inHeredoc) {
      if (line.trim() === '"""') {
        inHeredoc = false;
        const input = flushBuffer();
        if (input) await processInput(initialAttachments);
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
    flushTimer = setTimeout(() => processInput(initialAttachments), FLUSH_DELAY_MS);
  });
};


export async function startRepl(initialAttachments = null) {
  currentAgentName = null; // Clear agent mode for base tim REPL
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ui.prompt(),
  });
  setReadline(rl);

  // readline auto-closes on SIGINT unless the interface has its own listener
  process.on("SIGINT", handleSigint);
  rl.on("SIGINT", handleSigint);
  rl.on("close", () => process.exit(0));

  const yolo = isAutoAccept();
  ui.banner(await getModel(), process.cwd(), yolo);
  ui.success("hey 👋 i'm tim, what can i help you with?");
  setupLineHandler(initialAttachments);
  safePrompt();

  return rl;
}

// Start REPL with a specific agent already loaded (for `tim <agent>` command)
// The agent param is the object returned by createAgent() in react.js
// initialTask: optional task to run immediately on startup
export async function startReplWithAgent(agent, initialAttachments = null, initialTask = "") {
  currentAgentName = agent.state.profile?.name || null;
  
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ui.agentPrompt(currentAgentName),
  });
  setReadline(rl);

  // Set up the global agent references so the REPL uses this agent
  const react = await import("./react.js");
  react.setMainAgent(agent);

  // readline auto-closes on SIGINT unless the interface has its own listener
  process.on("SIGINT", handleSigint);
  rl.on("SIGINT", handleSigint);
  rl.on("close", () => process.exit(0));

  const yolo = isAutoAccept();
  ui.agentBanner(currentAgentName, agent.getModel(), process.cwd(), yolo);
  setupLineHandler(initialAttachments);
  
  // If there's an initial task, run it
  if (initialTask) {
    ui.info(`running initial task: ${initialTask.slice(0, 60)}${initialTask.length > 60 ? "..." : ""}`);
    await processRaw(initialTask, initialAttachments);
  } else {
    safePrompt();
  }

  return rl;
}

export function stopRepl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
