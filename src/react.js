// The ReAct loop runtime — manages conversation state, calls the LLM, runs tools.

import fs from "node:fs";
import path from "node:path";
import { getTools, getToolSchemas } from "./tools/index.js";
import { loadProjectContext } from "./config.js";
import { formatMemoryForContext } from "./memory.js";
import { createSession, save as saveSession } from "./session.js";
import { rehydrateReadsFromMessages } from "./tools/fs.js";

import { stream, streamCompletion, complete, Interrupted, getContextLimit } from "./llm.js";
import { ToolCache } from "./cache.js";
import { isPlanMode } from "./permissions.js";
import { isCwdTimSource, timPath } from "./paths.js";
import { commit as commitHistory } from "./history.js";
import * as ui from "./ui.js";

const PLAN_PREFIX =
  "[PLAN MODE] Research freely with read_file / grep / glob / list_files, " +
  "but DO NOT call edit_file, write_file, or bash. Draft a short numbered " +
  "plan (files to change, what to change, in what order) and stop. The user " +
  "will run /plan to exit plan mode, then tell you to proceed.\n\n";


const encodeFile = (filePath) => {
  const data = fs.readFileSync(filePath);
  return data.toString("base64");
};

const getMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };
  return mimeTypes[ext] || "application/octet-stream";
};

const buildUserMessage = (text, attachments) => {
  if (!attachments || (attachments.images.length === 0 && attachments.pdfs.length === 0)) {
    return { role: "user", content: text };
  }

  // Surface the on-disk paths so the model can pass them to tools like
  // generate_image (reference_images) or read_file. Without this the model
  // only sees pixels/bytes and has no way to refer to the file by path.
  const allPaths = [...attachments.images, ...attachments.pdfs];
  const pathsNote = `[attached files: ${allPaths.join(", ")}]\n`;
  const content = [{ type: "text", text: pathsNote + text }];

  for (const imgPath of attachments.images) {
    const base64 = encodeFile(imgPath);
    const mimeType = getMimeType(imgPath);
    content.push({
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${base64}` },
    });
  }

  for (const pdfPath of attachments.pdfs) {
    const base64 = encodeFile(pdfPath);
    content.push({
      type: "file",
      file: {
        filename: path.basename(pdfPath),
        file_data: `data:application/pdf;base64,${base64}`,
      },
    });
  }

  return { role: "user", content };
};

// Tools with no side effects (and no user prompt) can run concurrently.
// Everything else must stay serial: either it mutates disk/state, or it
// shows a confirm() prompt that can't be interleaved.
const PARALLEL_SAFE = new Set([
  "read_file",
  "list_files",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
]);
const isParallelSafe = (name) => PARALLEL_SAFE.has(name);

const DEFAULT_MODEL =
  process.env.TIM_MODEL || "accounts/fireworks/routers/kimi-k2p5-turbo";

const COMPACT_THRESHOLD = 0.6;


// Agents always get these tools so orchestration + memory upkeep work even
// when a profile sets a restrictive `tools: [...]` allowlist.
const AGENT_BASE_TOOLS = ["spawn_workflow", "update_memory", "append_memory"];

export async function createAgent(profile = null) {
  const allTools = await getTools();
  const allSchemas = await getToolSchemas();

  // If no profile, check for a 'default' agent to use as base
  let effectiveProfile = profile;
  if (!effectiveProfile) {
    const { loadAgents } = await import("./agents.js");
    const agents = loadAgents();
    if (agents.default) {
      effectiveProfile = agents.default;
    }
  }

  let toolAllowlist = effectiveProfile?.tools;
  // Profiles loaded from $TIM_DIR/agents/ are always identity-level agents;
  // workflows carry their own allowlist when spawned. We always merge base
  // tools so memory + spawning aren't accidentally excluded.
  if (toolAllowlist && effectiveProfile) {
    toolAllowlist = Array.from(new Set([...toolAllowlist, ...AGENT_BASE_TOOLS]));
  }

  const tools = toolAllowlist
    ? Object.fromEntries(Object.entries(allTools).filter(([n]) => toolAllowlist.includes(n)))
    : allTools;
  const toolSchemas = toolAllowlist
    ? Object.values(tools).map((t) => t.schema)
    : allSchemas;

  const state = {
    model: effectiveProfile?.model || profile?.model || DEFAULT_MODEL,
    messages: [],
    session: null,
    usage: { prompt: 0, completion: 0, lastPrompt: 0 },
    toolCache: new ToolCache(),
    profile: effectiveProfile || profile,
    persist: true, // always persist sessions for interactive REPL use
  };

  const buildSystem = () => {
    const toolList = Object.keys(tools).join(", ");
    const paths = `\n\n## tim dir (use for all user-specific output)
$TIM_DIR (${process.env.TIM_DIR}) is the root for any reports, logs, data,
or other artifacts you generate for the user. Create a subfolder under it
when grouping makes sense (e.g. recurring reports for a topic, or by source)
— otherwise write directly into $TIM_DIR. Use kebab-case for folder names.
Never write user-specific output to the current working directory unless
the user is editing files in this project.`;
    const selfEdit = isCwdTimSource()
      ? `\n\n## editing tim itself
You are in tim's own source directory. These files are git-tracked — if the
user wants to revert a change, use bash for \`git diff\`, \`git checkout -- <path>\`,
or \`git log\` to find the prior version.`
      : "";
    const customizations = `\n\n## reverting user customizations
$TIM_DIR (agents/, workflows/, tools/, memory/, TIM.md, etc.) is a git repo —
every turn auto-commits any changes. If the user asks to revert or undo, use
bash with \`git -C $TIM_DIR log <path>\`, \`git -C $TIM_DIR show <sha>:<path>\`,
or \`git -C $TIM_DIR checkout <sha> -- <path>\` to restore prior versions.`;

    // Auto-load the agent's own memory file (per-agent, not per-domain).
    const memorySection = effectiveProfile?.name ? formatMemoryForContext(effectiveProfile.name) : "";

    const agentPreamble = effectiveProfile
      ? `\n\n## Memory + orchestration
- Your memory file (above) is yours alone. It's auto-loaded at the start of
  every run so you already have the context. Do not read it with tools.
- When you learn something durable (a pattern that worked, a stable user
  preference, a channel-voice observation) call append_memory with a short
  semantic section heading. Only use update_memory for a full rewrite when
  the file has drifted.
- Do NOT save run summaries, daily reports, or activity logs to memory —
  those belong in your reply to the user (or in an email you send). Memory
  is for facts worth remembering across runs.
- Dispatch task-shaped work to workflows via spawn_workflow. Each workflow
  is a short-lived sub-agent that returns its findings inline — no files
  written on the side.`
      : "";

    if (effectiveProfile?.systemPrompt) {
      return `${effectiveProfile.systemPrompt}${agentPreamble}${memorySection}\n\nYou are running in ${process.cwd()}. Available tools: ${toolList}.${paths}${selfEdit}${customizations}`;
    }
    const base = `You are tim, a minimal coding assistant running in ${process.cwd()}.
You have tools: ${toolList}.
- Prefer grep/glob over reading whole directories.
- You MUST read_file a file before edit_file.
- Use edit_file for surgical changes; write_file only for new files or full rewrites.

- Keep replies concise. When the task is done, stop calling tools and give a short final answer.`;
    const ctx = loadProjectContext();
    return (ctx ? `${base}\n\n${ctx}` : base) + paths + selfEdit + customizations + memorySection;
  };

  const reset = () => {
    state.messages = [{ role: "system", content: buildSystem() }];
    state.session = state.persist ? createSession(state.model) : null;
    if (state.session && state.profile?.name) {
      state.session.agent = state.profile.name;
    }
    state.usage = { prompt: 0, completion: 0, lastPrompt: 0 };
    state.toolCache.clear();
    rehydrateReadsFromMessages([]);
  };

  const resume = (data) => {
    state.messages = data.messages || [{ role: "system", content: buildSystem() }];
    state.session = {
      id: data.id,
      cwd: data.cwd,
      model: data.model || state.model,
      agent: data.agent || state.profile?.name || null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
    if (data.model) state.model = data.model;
    state.usage = data.usage || { prompt: 0, completion: 0, lastPrompt: 0 };
    state.toolCache.clear();
    rehydrateReadsFromMessages(state.messages);
  };

  const turn = async (userInput, signal, attachments = null) => {
    const text = isPlanMode() ? PLAN_PREFIX + userInput : userInput;
    const userMessage = buildUserMessage(text, attachments);
    state.messages.push(userMessage);

    try {
      while (true) {
        if (signal?.aborted) throw new Interrupted();

        const { message } = await streamCompletion(
          { model: state.model, messages: state.messages, toolSchemas, usage: state.usage },
          signal
        );
        state.messages.push(message);

        if (!message.tool_calls?.length) {
          if (state.persist) {
            const limit = getContextLimit(state.model);
            ui.statusFooter({
              lastPromptTokens: state.usage.lastPrompt,
              limit,
              sessionId: state.session?.id,
              model: state.model,
            });
            if (state.usage.lastPrompt / limit >= COMPACT_THRESHOLD) {
              ui.info(`context at ${Math.round((state.usage.lastPrompt / limit) * 100)}% — auto-compacting...`);
              await compactFn();
            }
          }
          return;
        }

        const pendingAttachments = [];
        const results = new Array(message.tool_calls.length);

        const runOne = async (call, idx) => {
          if (signal?.aborted) throw new Interrupted();
          const { name, arguments: argStr } = call.function;
          let result;
          let args = {};
          try {
            args = JSON.parse(argStr || "{}");
            ui.toolCall(name, args);
            const tool = tools[name];
            if (!tool) throw new Error(`Unknown tool: ${name}`);

            result = state.toolCache.get(name, args);
            if (result !== undefined) {
              ui.toolResult(`(cached) ${String(result).slice(0, 100)}`);
            } else {
              const ctx = { signal, toolCache: state.toolCache, agentName: state.profile?.name || null, llm: { complete }, timPath };
              result = await tool.run(args, ctx);
              let cacheDeps;
              if (result && typeof result === "object" && !Array.isArray(result)) {
                if (Array.isArray(result.attachImages))
                  pendingAttachments.push(...result.attachImages);
                cacheDeps = result.cacheDeps;
                result = result.content ?? "";
              }
              if (!String(result).startsWith("ERROR:")) {
                state.toolCache.set(name, args, result, cacheDeps);
              } else {
                ui.toolResult(result);
              }
            }
          } catch (e) {
            result = `ERROR: ${e.message}`;
            ui.toolResult(result);
          }
          results[idx] = { call, content: String(result) };
        };

        // Batch reads together; run mutating/prompting tools one at a time.
        // Preserves tool_call order in the final messages but pays only the
        // slowest read in each batch instead of the sum.
        let i = 0;
        while (i < message.tool_calls.length) {
          if (signal?.aborted) throw new Interrupted();
          const startName = message.tool_calls[i].function.name;
          if (isParallelSafe(startName)) {
            const batch = [];
            while (
              i < message.tool_calls.length &&
              isParallelSafe(message.tool_calls[i].function.name)
            ) {
              batch.push(runOne(message.tool_calls[i], i));
              i++;
            }
            await Promise.all(batch);
          } else {
            await runOne(message.tool_calls[i], i);
            i++;
          }
        }

        for (const r of results) {
          state.messages.push({
            role: "tool",
            tool_call_id: r.call.id,
            content: r.content,
          });
        }

        if (pendingAttachments.length) {
          const noun = pendingAttachments.length > 1 ? "images" : "image";
          const content = [
            {
              type: "text",
              text: `(generated ${noun} attached for review: ${pendingAttachments.join(", ")})`,
            },
          ];
          for (const p of pendingAttachments) {
            content.push({
              type: "image_url",
              image_url: { url: `data:${getMimeType(p)};base64,${encodeFile(p)}` },
            });
          }
          state.messages.push({ role: "user", content });
          ui.info(`attached ${pendingAttachments.length} generated ${noun} to context`);
        }
      }
    } finally {
      if (state.session && state.persist) saveSession(state.session, state.messages, state.usage);
      try { commitHistory(`turn: ${String(userInput).slice(0, 80)}`); } catch {}
    }
  };

  const compactFn = async () => {
    const system = state.messages[0];
    const tail = state.messages.slice(-4);
    const middle = state.messages.slice(1, -4);
    if (middle.length < 4) return "Nothing to compact yet.";

    const summaryPrompt = [
      system,
      {
        role: "user",
        content:
          "Summarize the conversation so far in <=400 words. Capture: files read/edited, commands run, decisions made, and outstanding TODOs. Plain prose, no preamble.",
      },
      ...middle,
    ];

    let summary = "";
    const spin = ui.spinner("compacting");
    try {
      for await (const chunk of stream({ model: state.model, messages: summaryPrompt })) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) summary += delta;
      }
    } finally {
      spin.stop();
    }

    state.messages = [
      system,
      { role: "user", content: `[Summary of earlier conversation]\n${summary}` },
      { role: "assistant", content: "Got it — continuing from the summary." },
      ...tail,
    ];
    if (state.session && state.persist) saveSession(state.session, state.messages, state.usage);
    return `Compacted. Kept ${state.messages.length} messages.`;
  };

  reset();

  return {
    state,
    turn,
    compact: compactFn,
    reset,
    resume,
    getModel: () => state.model,
    setModel: (m) => { state.model = m; },
    getSessionId: () => state.session?.id,
  };
}


let main = null;
let mainReady = null;
const ensureMain = () => (mainReady ||= createAgent().then((a) => { main = a; }));
const lazy = (m) => async (...args) => { await ensureMain(); return main[m](...args); };

export const agentTurn     = lazy("turn");
export const compact       = lazy("compact");
export const resetMessages = lazy("reset");
export const resumeSession = lazy("resume");
export const getModel      = lazy("getModel");
export const setModel      = lazy("setModel");
export const getSessionId  = lazy("getSessionId");
export const hasProjectContext = () => !!loadProjectContext();

// For starting REPL with a specific agent (tim <agent> command)
export function setMainAgent(agent) {
  main = agent;
  mainReady = Promise.resolve(agent);
}

// Check if we're currently in agent mode (vs base tim)
export function isAgentMode() {
  return main?.state?.profile?.name != null;
}

// Switch back to base tim from agent mode
export async function clearAgent() {
  main = null;
  mainReady = createAgent().then((a) => { main = a; });
  await mainReady;
}
