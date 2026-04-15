// The main agent loop.
// Manages conversation state, calls the LLM, executes tool calls, caches results.
// Exports: agentTurn(), compact(), plus session/model/state getters.

import { tools, toolSchemas } from "./tools/index.js";
import { loadProjectContext } from "./config.js";
import { createSession, save as saveSession } from "./session.js";
import { rehydrateReadsFromMessages } from "./tools/fs.js";
import { complete } from "./llm.js";
import { streamCompletion, Interrupted } from "./streaming.js";
import { ToolCache } from "./cache.js";
import * as ui from "./ui.js";

const DEFAULT_MODEL =
  process.env.TIM_MODEL || "accounts/fireworks/routers/kimi-k2p5-turbo";

const CONTEXT_LIMIT = Number(process.env.TIM_CONTEXT_LIMIT || 128_000);
const COMPACT_THRESHOLD = 0.6; // Auto-compact at 60% to balance context retention

const state = {
  model: DEFAULT_MODEL,
  messages: [],
  session: null,
  usage: { prompt: 0, completion: 0, lastPrompt: 0 },
  toolCache: new ToolCache(),
};

const buildSystem = () => {
  const base = `You are tim, a minimal coding assistant running in ${process.cwd()}.
You have tools: ${Object.keys(tools).join(", ")}.
- Prefer grep/glob over reading whole directories.
- You MUST read_file a file before edit_file.
- Use edit_file for surgical changes; write_file only for new files or full rewrites.
- Keep replies concise. When the task is done, stop calling tools and give a short final answer.`;
  const ctx = loadProjectContext();
  return ctx ? `${base}\n\n${ctx}` : base;
};

export function resetMessages() {
  state.messages = [{ role: "system", content: buildSystem() }];
  state.session = createSession(state.model);
  state.usage = { prompt: 0, completion: 0, lastPrompt: 0 };
  state.toolCache.clear();
  rehydrateReadsFromMessages([]);
}
resetMessages();

export function resumeSession(data) {
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
}

export const getModel = () => state.model;
export const setModel = (m) => {
  state.model = m;
};
export const getSessionId = () => state.session?.id;
export const hasProjectContext = () => !!loadProjectContext();
export const getUsage = () => ({
  ...state.usage,
  limit: CONTEXT_LIMIT,
  pctUsed: Math.round((state.usage.lastPrompt / CONTEXT_LIMIT) * 100),
});

export async function agentTurn(userInput, signal) {
  state.messages.push({ role: "user", content: userInput });

  try {
    while (true) {
      if (signal?.aborted) throw new Interrupted();

      const { message } = await streamCompletion(
        { model: state.model, messages: state.messages, toolSchemas, usage: state.usage },
        signal
      );
      state.messages.push(message);

      if (!message.tool_calls?.length) {
        ui.statusFooter({
          lastPromptTokens: state.usage.lastPrompt,
          limit: CONTEXT_LIMIT,
          sessionId: state.session?.id,
          model: state.model,
        });
        
        // Auto-compact at threshold to stay lean
        if (state.usage.lastPrompt / CONTEXT_LIMIT >= COMPACT_THRESHOLD) {
          ui.info(`context at ${Math.round((state.usage.lastPrompt / CONTEXT_LIMIT) * 100)}% — auto-compacting...`);
          await compact();
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
}

export async function compact() {
  const system = state.messages[0];
  const tail = state.messages.slice(-4);
  const middle = state.messages.slice(1, -4);
  if (middle.length < 4) {
    return "Nothing to compact yet.";
  }

  const summaryPrompt = [
    system,
    {
      role: "user",
      content:
        "Summarize the conversation so far in <=400 words. Capture: files read/edited, commands run, decisions made, and outstanding TODOs. Plain prose, no preamble.",
    },
    ...middle,
  ];

  const res = await complete({
    model: state.model,
    messages: summaryPrompt,
  });
  const summary = res.choices[0].message.content;

  state.messages = [
    system,
    { role: "user", content: `[Summary of earlier conversation]\n${summary}` },
    { role: "assistant", content: "Got it — continuing from the summary." },
    ...tail,
  ];
  if (state.session) saveSession(state.session, state.messages, state.usage);
  return `Compacted. Kept ${state.messages.length} messages.`;
}
