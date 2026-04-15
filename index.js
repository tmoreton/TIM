#!/usr/bin/env node
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const API_KEY = process.env.FIREWORKS_API_KEY;
if (!API_KEY) {
  console.error("Set FIREWORKS_API_KEY in your environment.");
  process.exit(1);
}

const MODEL =
  process.env.TIM_MODEL || "accounts/fireworks/routers/kimi-k2p5-turbo";

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: "https://api.fireworks.ai/inference/v1",
});

const CWD = process.cwd();

const resolveSafe = (p) => {
  const abs = path.resolve(CWD, p);
  if (!abs.startsWith(CWD)) throw new Error(`Path outside workspace: ${p}`);
  return abs;
};

const tools = {
  list_files: {
    schema: {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories at a relative path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path. Defaults to '.'" },
          },
        },
      },
    },
    run: ({ path: p = "." }) => {
      const abs = resolveSafe(p);
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    },
  },
  read_file: {
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the full contents of a text file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    run: ({ path: p }) => fs.readFileSync(resolveSafe(p), "utf8"),
  },
  edit_file: {
    schema: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Write/overwrite a file with the given content. Creates parent dirs.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    run: ({ path: p, content }) => {
      const abs = resolveSafe(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return `Wrote ${content.length} bytes to ${p}`;
    },
  },
};

const toolSchemas = Object.values(tools).map((t) => t.schema);

const SYSTEM = `You are tim, a minimal coding assistant running in ${CWD}.
Use tools to list, read, and edit files. Keep replies concise.
When a task is done, stop calling tools and give a short final answer.`;

const messages = [{ role: "system", content: SYSTEM }];

async function agentTurn(userInput) {
  messages.push({ role: "user", content: userInput });

  while (true) {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: toolSchemas,
    });

    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (msg.content) console.log(`\ntim> ${msg.content}\n`);
      return;
    }

    for (const call of msg.tool_calls) {
      const { name, arguments: argStr } = call.function;
      let result;
      try {
        const args = JSON.parse(argStr || "{}");
        console.log(`  · ${name}(${JSON.stringify(args)})`);
        result = tools[name].run(args);
      } catch (e) {
        result = `ERROR: ${e.message}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(result),
      });
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "you> ",
});

console.log(`tim (${MODEL}) in ${CWD}\nType 'exit' to quit.\n`);
rl.prompt();
rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) return rl.prompt();
  if (input === "exit" || input === "quit") process.exit(0);
  try {
    await agentTurn(input);
  } catch (e) {
    console.error(`error: ${e.message}`);
  }
  rl.prompt();
});
