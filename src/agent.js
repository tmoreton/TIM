import { tools, toolSchemas } from "./tools/index.js";
import { loadProjectContext } from "./config.js";
import { createSession, save as saveSession } from "./session.js";
import { rehydrateReadsFromMessages } from "./tools/fs.js";
import { complete, stream } from "./llm.js";
import * as ui from "./ui.js";

const DEFAULT_MODEL =
  process.env.TIM_MODEL || "accounts/fireworks/routers/kimi-k2p5-turbo";

const CONTEXT_LIMIT = Number(process.env.TIM_CONTEXT_LIMIT || 128_000);

const state = {
  model: DEFAULT_MODEL,
  messages: [],
  session: null,
  usage: { prompt: 0, completion: 0, lastPrompt: 0 },
  toolCache: new Map(),
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

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
    this.name = "Interrupted";
  }
}

async function streamCompletion(signal) {
  const chunks = stream(
    {
      model: state.model,
      messages: state.messages,
      tools: toolSchemas,
      stream_options: { include_usage: true },
    },
    { signal },
  );

  let content = "";
  const toolAcc = [];
  let started = false;
  let usage = null;
  let lineBuf = "";

  const spin = ui.spinner("thinking");
  const stopSpinner = () => spin.stop();

  const flushLines = (final = false) => {
    let idx;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      process.stdout.write("  " + ui.renderMarkdownLine(line) + "\n");
    }
    if (final && lineBuf) {
      process.stdout.write("  " + ui.renderMarkdownLine(lineBuf) + "\n");
      lineBuf = "";
    }
  };

  try {
    ui.resetMarkdown();
    for await (const chunk of chunks) {
      if (signal?.aborted) throw new Interrupted();
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        if (!started) {
          stopSpinner();
          process.stdout.write(`\n${ui.header()}\n`);
          started = true;
        }
        lineBuf += delta.content;
        content += delta.content;
        flushLines();
      }

      if (delta.tool_calls) {
        if (!started) stopSpinner();
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolAcc[i] ||= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function?.name) toolAcc[i].function.name += tc.function.name;
          if (tc.function?.arguments)
            toolAcc[i].function.arguments += tc.function.arguments;
        }
      }

    }
  } finally {
    stopSpinner();
    flushLines(true);
  }

  if (started) process.stdout.write("\n");
  const toolCalls = toolAcc.filter(Boolean);

  if (usage) {
    state.usage.prompt += usage.prompt_tokens || 0;
    state.usage.completion += usage.completion_tokens || 0;
    state.usage.lastPrompt = usage.prompt_tokens || 0;
  }

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
  };
}

export async function agentTurn(userInput, signal) {
  state.messages.push({ role: "user", content: userInput });

  try {
    while (true) {
      if (signal?.aborted) throw new Interrupted();

      const { message } = await streamCompletion(signal);
      state.messages.push(message);

      if (!message.tool_calls?.length) {
        ui.statusFooter({
          lastPromptTokens: state.usage.lastPrompt,
          limit: CONTEXT_LIMIT,
          sessionId: state.session?.id,
          model: state.model,
        });
        if (state.usage.lastPrompt / CONTEXT_LIMIT >= 0.8)
          ui.info("context filling up — run /compact");
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
          
          // Simple cache for deterministic reads (read_file, list_files, grep, glob)
          const cacheable = ["read_file", "list_files", "grep", "glob"].includes(name);
          const cacheKey = cacheable ? `${name}:${JSON.stringify(args)}` : null;
          
          if (cacheKey && state.toolCache.has(cacheKey)) {
            result = state.toolCache.get(cacheKey);
            ui.toolResult(`(cached) ${String(result).slice(0, 100)}`);
          } else {
            result = await tool.run(args, { signal });
            if (cacheKey && !String(result).startsWith("ERROR:")) {
              state.toolCache.set(cacheKey, result);
              // Keep cache size bounded
              if (state.toolCache.size > 100) {
                const firstKey = state.toolCache.keys().next().value;
                state.toolCache.delete(firstKey);
              }
            }
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
