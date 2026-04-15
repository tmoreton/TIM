import OpenAI from "openai";
import { tools, toolSchemas } from "./tools/index.js";
import { loadProjectContext } from "./config.js";
import { createSession, save as saveSession } from "./session.js";
import { rehydrateReadsFromMessages } from "./tools/fs.js";

const DEFAULT_MODEL =
  process.env.TIM_MODEL || "accounts/fireworks/routers/kimi-k2p5-turbo";

const CONTEXT_LIMIT = Number(process.env.TIM_CONTEXT_LIMIT || 128_000);

const state = {
  model: DEFAULT_MODEL,
  messages: [],
  session: null,
  usage: { prompt: 0, completion: 0, lastPrompt: 0 },
};

let _client = null;
const getClient = () => {
  if (_client) return _client;
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    console.error("Set FIREWORKS_API_KEY in your environment.");
    process.exit(1);
  }
  _client = new OpenAI({
    apiKey,
    baseURL: "https://api.fireworks.ai/inference/v1",
  });
  return _client;
};

const buildSystem = () => {
  const base = `You are tim, a minimal coding assistant running in ${process.cwd()}.
You have tools: list_files, read_file, edit_file, write_file, bash, grep, glob.
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
export const getState = () => state;
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
  const stream = await getClient().chat.completions.create(
    {
      model: state.model,
      messages: state.messages,
      tools: toolSchemas,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal },
  );

  let content = "";
  const toolAcc = [];
  let finishReason = null;
  let started = false;
  let usage = null;

  for await (const chunk of stream) {
    if (signal?.aborted) throw new Interrupted();
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};

    if (delta.content) {
      if (!started) {
        process.stdout.write("\ntim> ");
        started = true;
      }
      process.stdout.write(delta.content);
      content += delta.content;
    }

    if (delta.tool_calls) {
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

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  if (started) process.stdout.write("\n\n");
  const toolCalls = toolAcc.filter(Boolean);

  if (usage) {
    state.usage.prompt += usage.prompt_tokens || 0;
    state.usage.completion += usage.completion_tokens || 0;
    state.usage.lastPrompt = usage.prompt_tokens || 0;
    const pct = (usage.prompt_tokens || 0) / CONTEXT_LIMIT;
    if (pct >= 0.8) {
      console.log(
        `  ⚠ context ${Math.round(pct * 100)}% full (${usage.prompt_tokens}/${CONTEXT_LIMIT}) — run /compact`,
      );
    }
  }

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    finishReason,
  };
}

export async function agentTurn(userInput, signal) {
  state.messages.push({ role: "user", content: userInput });

  try {
    while (true) {
      if (signal?.aborted) throw new Interrupted();

      const { message } = await streamCompletion(signal);
      state.messages.push(message);

      if (!message.tool_calls?.length) return;

      for (const call of message.tool_calls) {
        if (signal?.aborted) throw new Interrupted();
        const { name, arguments: argStr } = call.function;
        let result;
        try {
          const args = JSON.parse(argStr || "{}");
          const preview = JSON.stringify(args).slice(0, 120);
          console.log(`  · ${name}(${preview})`);
          const tool = tools[name];
          if (!tool) throw new Error(`Unknown tool: ${name}`);
          result = await tool.run(args, { signal });
        } catch (e) {
          result = `ERROR: ${e.message}`;
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

  const res = await getClient().chat.completions.create({
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
