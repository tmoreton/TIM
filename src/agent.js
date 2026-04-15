// The main agent loop.
// Manages conversation state, calls the LLM, executes tool calls, caches results.
// Exports: createAgent() factory + a default instance whose methods are re-exported
// for backward compatibility (agentTurn, compact, resetMessages, etc).

import fs from "node:fs";
import path from "node:path";
import { tools as allTools, toolSchemas as allSchemas } from "./tools/index.js";
import { loadProjectContext } from "./config.js";
import { createSession, save as saveSession } from "./session.js";
import { rehydrateReadsFromMessages } from "./tools/fs.js";
import { complete } from "./llm.js";
import { streamCompletion, Interrupted } from "./streaming.js";
import { ToolCache } from "./cache.js";
import * as ui from "./ui.js";

// --- Multimodal helpers ----------------------------------------------------

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

  const content = [{ type: "text", text }];

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

const DEFAULT_MODEL =
  process.env.TIM_MODEL || "accounts/fireworks/routers/kimi-k2p5-turbo";

const CONTEXT_LIMIT = Number(process.env.TIM_CONTEXT_LIMIT || 128_000);
const COMPACT_THRESHOLD = 0.6;

// --- Agent factory ---------------------------------------------------------

export function createAgent(profile = null) {
  const tools = profile?.tools
    ? Object.fromEntries(Object.entries(allTools).filter(([n]) => profile.tools.includes(n)))
    : allTools;
  const toolSchemas = profile?.tools
    ? Object.values(tools).map((t) => t.schema)
    : allSchemas;

  const state = {
    model: profile?.model || DEFAULT_MODEL,
    messages: [],
    session: null,
    usage: { prompt: 0, completion: 0, lastPrompt: 0 },
    toolCache: new ToolCache(),
    profile,
    persist: !profile, // sub-agents don't write sessions by default
  };

  const buildSystem = () => {
    const toolList = Object.keys(tools).join(", ");
    if (profile?.systemPrompt) {
      return `${profile.systemPrompt}\n\nYou are running in ${process.cwd()}. Available tools: ${toolList}.`;
    }
    const base = `You are tim, a minimal coding assistant running in ${process.cwd()}.
You have tools: ${toolList}.
- Prefer grep/glob over reading whole directories.
- You MUST read_file a file before edit_file.
- Use edit_file for surgical changes; write_file only for new files or full rewrites.
- Keep replies concise. When the task is done, stop calling tools and give a short final answer.`;
    const ctx = loadProjectContext();
    return ctx ? `${base}\n\n${ctx}` : base;
  };

  const reset = () => {
    state.messages = [{ role: "system", content: buildSystem() }];
    state.session = state.persist ? createSession(state.model) : null;
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
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
    if (data.model) state.model = data.model;
    state.usage = data.usage || { prompt: 0, completion: 0, lastPrompt: 0 };
    state.toolCache.clear();
    rehydrateReadsFromMessages(state.messages);
  };

  const turn = async (userInput, signal, attachments = null) => {
    const userMessage = buildUserMessage(userInput, attachments);
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
            ui.statusFooter({
              lastPromptTokens: state.usage.lastPrompt,
              limit: CONTEXT_LIMIT,
              sessionId: state.session?.id,
              model: state.model,
            });
            if (state.usage.lastPrompt / CONTEXT_LIMIT >= COMPACT_THRESHOLD) {
              ui.info(`context at ${Math.round((state.usage.lastPrompt / CONTEXT_LIMIT) * 100)}% — auto-compacting...`);
              await compactFn();
            }
          }
          return;
        }

        for (const call of message.tool_calls) {
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
              result = await tool.run(args, { signal });
              state.toolCache.set(name, args, result);
              if (String(result).startsWith("ERROR:")) ui.toolResult(result);
            }
          } catch (e) {
            result = `ERROR: ${e.message}`;
            ui.toolResult(result);
          }
          state.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: String(result),
          });
        }
      }
    } finally {
      if (state.session) saveSession(state.session, state.messages, state.usage);
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

    const res = await complete({ model: state.model, messages: summaryPrompt });
    const summary = res.choices[0].message.content;

    state.messages = [
      system,
      { role: "user", content: `[Summary of earlier conversation]\n${summary}` },
      { role: "assistant", content: "Got it — continuing from the summary." },
      ...tail,
    ];
    if (state.session) saveSession(state.session, state.messages, state.usage);
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
    getUsage: () => ({
      ...state.usage,
      limit: CONTEXT_LIMIT,
      pctUsed: Math.round((state.usage.lastPrompt / CONTEXT_LIMIT) * 100),
    }),
  };
}

// --- Default agent + back-compat exports -----------------------------------

const main = createAgent();

export const agentTurn = (input, signal, attachments) => main.turn(input, signal, attachments);
export const compact = () => main.compact();
export const resetMessages = () => main.reset();
export const resumeSession = (data) => main.resume(data);
export const getModel = () => main.getModel();
export const setModel = (m) => main.setModel(m);
export const getSessionId = () => main.getSessionId();
export const getUsage = () => main.getUsage();
export const hasProjectContext = () => !!loadProjectContext();
