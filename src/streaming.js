// Handles streaming LLM responses: parses SSE chunks, renders markdown line-by-line,
// manages the "thinking" spinner, accumulates tool calls, tracks token usage.

import * as ui from "./ui.js";
import { stream } from "./llm.js";

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
    this.name = "Interrupted";
  }
}

export async function streamCompletion({ model, messages, toolSchemas, usage }, signal) {
  const chunks = stream(
    {
      model,
      messages,
      tools: toolSchemas,
      stream_options: { include_usage: true },
    },
    { signal },
  );

  let content = "";
  const toolAcc = [];
  let started = false;
  let responseUsage = null;
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
      if (chunk.usage) responseUsage = chunk.usage;
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

  // Update usage if provided
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
