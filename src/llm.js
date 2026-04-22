// LLM client with streaming, retry logic, and provider routing.
// Exports: complete(), stream(), streamCompletion(), Interrupted,
// getContextLimit(), getModelCatalog()

import * as ui from "./ui.js";


const requireKey = (envVar) => {
  const k = process.env[envVar];
  if (!k) throw new Error(`${envVar} not set. Run \`/env set ${envVar}=...\``);
  return k;
};

const providers = {
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireKey("FIREWORKS_API_KEY")}`,
    }),
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    prefix: "openrouter/",
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireKey("OPENROUTER_API_KEY")}`,
      "HTTP-Referer": "https://github.com/tmoreton/tim",
      "X-Title": "tim",
    }),
  },
};

const DEFAULT_PROVIDER = providers.fireworks;

const pickProvider = (model = "") => {
  for (const cfg of Object.values(providers)) {
    if (cfg.prefix && model.startsWith(cfg.prefix)) {
      return { provider: cfg, model: model.slice(cfg.prefix.length) };
    }
  }
  return { provider: DEFAULT_PROVIDER, model };
};

// Curated catalog for `/model` / `/models`. OpenRouter entries are only
// shown when OPENROUTER_API_KEY is set. Any ID can still be passed manually
// to /model — this list is just quick-pick shortcuts.
const MODEL_CATALOG = [
  { id: "accounts/fireworks/routers/kimi-k2p5-turbo", label: "Kimi K2.5 Turbo", provider: "fireworks", contextLimit: 262_144 },
  { id: "openrouter/anthropic/claude-opus-4.7", label: "Claude Opus 4.7", provider: "openrouter", contextLimit: 262_144 },
  { id: "openrouter/openai/gpt-5", label: "GPT-5", provider: "openrouter", contextLimit: 262_144 },
  { id: "openrouter/moonshotai/kimi-k2.6", label: "Kimi K2.6", provider: "openrouter", contextLimit: 262_144 },
  { id: "openrouter/google/gemini-3-pro", label: "Gemini 3 Pro", provider: "openrouter", contextLimit: 1_000_000 },
  { id: "openrouter/google/gemma-4-31b-it", label: "Gemma 4 31B", provider: "openrouter", contextLimit: 262_144 },
  { id: "openrouter/qwen/qwen3.5-122b-a10b", label: "Qwen 3.5 122B", provider: "openrouter", contextLimit: 262_144 },
];

export const getContextLimit = (model = "") => {
  if (process.env.TIM_CONTEXT_LIMIT) return Number(process.env.TIM_CONTEXT_LIMIT);
  const found = MODEL_CATALOG.find((m) => m.id === model);
  return found?.contextLimit || 262_144;
};

export const getModelCatalog = () =>
  MODEL_CATALOG.filter((m) => {
    if (m.provider === "fireworks") return !!process.env.FIREWORKS_API_KEY;
    if (m.provider === "openrouter") return !!process.env.OPENROUTER_API_KEY;
    return true;
  });


const stripReasoning = (messages) =>
  messages?.map(({ reasoning, reasoning_content, ...rest }) => rest);

const resolveRequest = (body) => {
  const { provider, model } = pickProvider(body.model);
  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: provider.headers(),
    body: { ...body, model, messages: stripReasoning(body.messages) },
  };
};


const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const ESC = "\x1b[";
const clearLine = () => process.stdout.write(`\r${ESC}K`);

const backoff = (attempt) => 250 * 2 ** attempt + Math.floor(Math.random() * 250);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const fetchWithRetry = async (url, init) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !RETRY_STATUS.has(res.status) || attempt >= MAX_ATTEMPTS - 1) return res;
      const wait = (Number(res.headers.get("retry-after")) || 0) * 1000 || backoff(attempt);
      clearLine();
      process.stderr.write(`  retrying in ${Math.round(wait)}ms (HTTP ${res.status}, attempt ${attempt + 2}/${MAX_ATTEMPTS})`);
      await sleep(wait, init.signal);
      clearLine();
    } catch (e) {
      if (init.signal?.aborted || attempt >= MAX_ATTEMPTS - 1) {
        if (e?.cause?.code) e.message = `${e.message} (${e.cause.code})`;
        throw e;
      }
      const wait = backoff(attempt);
      clearLine();
      process.stderr.write(`  retrying in ${Math.round(wait)}ms (${e.cause?.code || e.message}, attempt ${attempt + 2}/${MAX_ATTEMPTS})`);
      await sleep(wait, init.signal);
      clearLine();
    }
  }
};

const throwIfBad = async (res) => {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  const err = new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  err.status = res.status;
  err.retryAfter = Number(res.headers.get("retry-after")) || 0;
  throw err;
};


export async function complete(body, { signal } = {}) {
  const p = resolveRequest(body);
  const res = await fetchWithRetry(p.url, {
    method: "POST",
    headers: p.headers,
    body: JSON.stringify(p.body),
    signal,
  });
  await throwIfBad(res);
  return res.json();
}


export async function* stream(body, { signal } = {}) {
  const p = resolveRequest({ ...body, stream: true });
  const res = await fetchWithRetry(p.url, {
    method: "POST",
    headers: p.headers,
    body: JSON.stringify(p.body),
    signal,
  });
  await throwIfBad(res);

  const decoder = new TextDecoder();
  let buffer = "";
  let lineBuffer = "";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      lineBuffer += line;
      if (line === "") {
        const m = lineBuffer.match(/data: (.+)/);
        if (m) {
          const payload = m[1].trim();
          if (payload === "[DONE]") return;
          try { yield JSON.parse(payload); } catch {}
        }
        lineBuffer = "";
      } else {
        lineBuffer += "\n";
      }
    }
  }
  if (buffer) {
    lineBuffer += buffer;
    const m = lineBuffer.match(/data: (.+)/);
    if (m) {
      const payload = m[1].trim();
      if (payload !== "[DONE]") {
        try { yield JSON.parse(payload); } catch {}
      }
    }
  }
}


export class Interrupted extends Error {
  constructor() {
    super("interrupted");
    this.name = "Interrupted";
  }
}

export async function streamCompletion({ model, messages, toolSchemas, usage }, signal) {
  const chunks = stream(
    { model, messages, tools: toolSchemas, stream_options: { include_usage: true } },
    { signal }
  );

  let content = "";
  const toolAcc = [];
  let started = false;
  let responseUsage = null;
  let lineBuf = "";
  const spin = ui.spinner("thinking");

  const flushLines = (final = false) => {
    let idx;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      process.stdout.write("  " + ui.renderMarkdownLine(lineBuf.slice(0, idx)) + "\n");
      lineBuf = lineBuf.slice(idx + 1);
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
      if (chunk.usage) responseUsage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        if (!started) {
          spin.stop();
          process.stdout.write(`\n${ui.header()}\n`);
          started = true;
        }
        lineBuf += delta.content;
        content += delta.content;
        flushLines();
      }

      if (delta.tool_calls) {
        if (!started) spin.stop();
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolAcc[i] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function?.name) toolAcc[i].function.name = tc.function.name;
          if (tc.function?.arguments) toolAcc[i].function.arguments += tc.function.arguments;
        }
      }
    }
  } finally {
    spin.stop();
    flushLines(true);
  }

  if (started) process.stdout.write("\n");
  const toolCalls = toolAcc.filter(Boolean);

  if (responseUsage) {
    usage.prompt += responseUsage.prompt_tokens || 0;
    usage.completion += responseUsage.completion_tokens || 0;
    usage.lastPrompt = responseUsage.prompt_tokens || 0;
  }

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
  };
}
