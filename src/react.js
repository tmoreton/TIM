// The ReAct loop runtime — manages conversation state, calls the LLM, runs tools.

import fs from "node:fs";
import path from "node:path";
import { getTools, getToolSchemas } from "./tools/index.js";
import { loadProjectContext } from "./config.js";
import { formatMemoryForContext } from "./memory.js";
import { createSession, save as saveSession } from "./session.js";
import { rehydrateReadsFromMessages } from "./tools/fs.js";
import { loadSkills } from "./skills.js";

import { spawnSync } from "node:child_process";

import { stream, streamCompletion, complete, getContextLimit } from "./llm.js";
import { ToolCache } from "./cache.js";
import { isPlanMode } from "./permissions.js";
import { timPath, agentOutputDir, isCwdTimSource } from "./paths.js";
import { commit as commitHistory } from "./history.js";
import * as ui from "./ui.js";
import {
  extractFileOpsInto,
  renderFileOps,
  serializeForSummary,
  FRESH_SUMMARY_INSTRUCTION,
  UPDATE_SUMMARY_INSTRUCTION,
} from "./compaction.js";

// Snapshot of the cwd for the system prompt. Without this the model sees only
// a one-line "Running in <cwd>" that gets drowned by $TIM_DIR-heavy guidance,
// and stops realizing the user's project IS the current directory.
const buildCwdContext = () => {
  const cwd = process.cwd();
  const lines = [`## Working directory: ${cwd}`];

  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .slice(0, 30)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length) lines.push(`Top-level: ${entries.join(", ")}`);
  } catch {}

  try {
    const branch = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8" }).stdout.trim();
    if (branch) lines.push(`Git branch: ${branch}`);
  } catch {}

  if (isCwdTimSource()) {
    lines.push(
      `You are in tim's own source directory — edits here change the CLI itself. ` +
      `It's git-tracked; use \`git diff\` / \`git checkout -- <path>\` for revert requests.`
    );
  }

  return lines.join("\n");
};

// Plan mode forces the model through explicit phases before producing steps.
// The structure alone makes the model spend more tokens on deliberation —
// no model-specific reasoning APIs required; this is just chain-of-thought
// scaffolding. After the first draft, turn() injects PLAN_CRITIQUE_PROMPT
// to force a pressure-test + revision pass before finalizing.
const PLAN_PREFIX = `[PLAN MODE — think before planning]

Work through these phases IN ORDER before producing any plan. Do NOT skip phases or jump to a numbered list.

## 1. Restate the task
What is the user asking for, in your own words? What does "done" look like? Surface any ambiguity now rather than guessing.

## 2. Investigate
Use read_file / grep / glob / list_files to build the context you need. edit_file, write_file, and bash are blocked. After investigating, note what you actually found that matters to the plan.

## 3. Assumptions & risks
- Assumptions you're making that the user should confirm
- Edge cases, failure modes, things that could break
- Anything you don't know yet that could change the plan

## 4. Options considered
Sketch 2–3 viable approaches. For each: what it does, tradeoffs, why you would or wouldn't pick it. Then name the chosen approach and say why.

## 5. The plan

### Files to touch
- \`path/to/file\` — what changes and why

### Step-by-step
1. concrete action (not "update X" — say what specifically changes)
2. ...

### Verification
Tests to run, commands to check, behavior to confirm it worked.

Stop after phase 5. Do NOT call edit_file, write_file, or bash. The user will /plan to exit plan mode and then tell you to proceed.

---

User's task:

`;

const PLAN_CRITIQUE_PROMPT = `Before finalizing, pressure-test the plan you just drafted. Answer honestly:

- What in the plan is under-specified or hand-wavy? (If a step says "update X" without naming the exact change, flag it.)
- Which step is most likely to fail? Why?
- What load-bearing assumption did you make that, if wrong, would invalidate the plan?
- Did you miss any file, call site, test, or config that would need to change?
- Is the verification concrete enough to know whether it worked?

Then output the FINAL plan using the same structure (Files to touch / Step-by-step / Verification), incorporating the fixes. If investigation is needed first, call read-only tools — edit_file, write_file, and bash are still blocked.

After the final plan, stop.`;


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
  // read_file. Without this the model
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

// End-of-turn compaction target (based on reported usage from last response).
const COMPACT_THRESHOLD = 0.6;

// Find the last "regular" user message (a turn boundary) — skipping the
// auto-generated attachment user messages we push after image-returning tools.
// Keeps tool_call / tool_result pairs together when compacting.
const findSafeTailStart = (messages) => {
  for (let i = messages.length - 1; i >= 1; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const firstText = Array.isArray(m.content)
      ? m.content.find((c) => c?.type === "text")?.text
      : m.content;
    if (typeof firstText === "string" && firstText.startsWith("(generated ")) continue;
    return i;
  }
  return -1;
};


// Agents always get these tools so orchestration + memory upkeep + skill
// consultation work even when a profile sets a restrictive `tools: [...]`
// allowlist. read_skill is baseline because skills are a read-only
// capability that any agent can benefit from when one matches.
const AGENT_BASE_TOOLS = ["spawn_workflow", "update_memory", "append_memory", "read_skill"];

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
    // Cumulative file-op tracking across compactions. Every compaction walks
    // the messages it's about to summarize, extracts paths touched by
    // read_file / write_file / edit_file tool calls, and merges them into
    // these sets. The trailer emitted into the summary lets the resumed
    // agent recall what files it's been working with even after the
    // details have been summarized away.
    compactionFileOps: { read: new Set(), modified: new Set() },
    lastCompactionSummary: null, // string, for iterative update prompts
  };

  // Build the "Available tools" block and the Guidelines block from the
  // ACTIVE tool set. Tools export an optional `promptSnippet` (one-liner in
  // the tools list) and `promptGuidelines[]` (bullets). An agent with a
  // narrow allowlist doesn't pay tokens for guidance about tools it can't
  // call.
  const buildToolsBlock = () => {
    const entries = Object.entries(tools);
    const lines = entries.map(([name, t]) =>
      t.promptSnippet ? `- ${t.promptSnippet}` : `- ${name}`
    );
    return `Available tools:\n${lines.join("\n")}`;
  };

  // Advertise available skills in the system prompt. Only name + description
  // per skill — bodies stay on disk and are lazy-loaded via read_skill when
  // the model decides a skill is relevant. Per-profile `skills: [...]`
  // allowlist narrows the visible set; omitted = all skills are visible.
  // Returns null when the effective set is empty so buildSystem can skip
  // the section entirely.
  const buildSkillsBlock = () => {
    const all = loadSkills();
    const names = Object.keys(all);
    if (!names.length) return null;
    const allow = effectiveProfile?.skills;
    const active = Array.isArray(allow)
      ? names.filter((n) => allow.includes(n))
      : names;
    if (!active.length) return null;
    const lines = active.map((n) => `- ${n}: ${all[n].description}`);
    return `Available skills (reusable procedures — call read_skill(name) to load the full body):
${lines.join("\n")}

When a user's task matches a skill description, read_skill BEFORE attempting the task — skills encode canonical steps, gotchas, and verification. Don't reinvent them.`;
  };

  const buildGuidelinesBlock = () => {
    const seen = new Set();
    const bullets = [];
    for (const t of Object.values(tools)) {
      for (const g of t.promptGuidelines || []) {
        if (seen.has(g)) continue;
        seen.add(g);
        bullets.push(`- ${g}`);
      }
    }
    // Always-on rule: concise finishes apply regardless of toolset.
    bullets.push("- Be concise; when the task is done, stop calling tools and give a short final answer.");
    return `Guidelines:\n${bullets.join("\n")}`;
  };

  const buildSystem = () => {
    const memorySection = effectiveProfile?.name ? formatMemoryForContext(effectiveProfile.name) : "";
    const ctx = loadProjectContext();
    const outDir = agentOutputDir(effectiveProfile?.name);
    const tail = `Write artifacts under ${outDir}/<kind>/ (e.g. ${outDir}/reports/, ${outDir}/images/, ${outDir}/scripts/), not cwd. Pick a kebab-case subfolder per artifact kind so the user can browse what you've made over time. For reusable helper scripts (default to Node.js), list_files ${outDir}/scripts/ first — reuse or extend instead of recreating. Each script needs a header comment with: purpose, usage, env vars, and "Created by: <agent> (workflow: <name>)". $TIM_DIR is a git repo with auto-commits — use \`git -C $TIM_DIR …\` for revert requests.`;
    const agentMemoryNote = effectiveProfile
      ? `Your memory is auto-loaded above — don't read it with tools. Call append_memory for durable facts; spawn_workflow for task-shaped work.`
      : "";

    const cwdContext = buildCwdContext();
    const toolsBlock = buildToolsBlock();
    const skillsBlock = buildSkillsBlock();
    const guidelinesBlock = buildGuidelinesBlock();

    if (effectiveProfile?.systemPrompt) {
      return [
        effectiveProfile.systemPrompt,
        cwdContext,
        toolsBlock,
        skillsBlock,
        guidelinesBlock,
        agentMemoryNote,
        ctx,
        memorySection,
        tail,
      ].filter(Boolean).join("\n\n");
    }

    const base = `You are tim, a minimal coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.`;

    return [base, cwdContext, toolsBlock, skillsBlock, guidelinesBlock, ctx, memorySection, tail].filter(Boolean).join("\n\n");
  };

  const reset = () => {
    state.messages = [{ role: "system", content: buildSystem() }];
    state.session = state.persist ? createSession(state.model) : null;
    if (state.session && state.profile?.name) {
      state.session.agent = state.profile.name;
    }
    state.usage = { prompt: 0, completion: 0, lastPrompt: 0 };
    state.toolCache.clear();
    state.compactionFileOps = { read: new Set(), modified: new Set() };
    state.lastCompactionSummary = null;
    rehydrateReadsFromMessages([]);
  };

  const resume = (data) => {
    // Always rebuild the system message on resume. The stored one was baked
    // at session-creation time and goes stale as tools are added/removed or
    // the profile's system prompt changes — the model follows the system
    // prompt's tool list literally, so a stale list produces "I don't have
    // that tool" refusals even when the schema is actually registered.
    const freshSystem = { role: "system", content: buildSystem() };
    const stored = data.messages;
    if (Array.isArray(stored) && stored.length > 0) {
      state.messages =
        stored[0]?.role === "system" ? [freshSystem, ...stored.slice(1)] : [freshSystem, ...stored];
    } else {
      state.messages = [freshSystem];
    }
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

  const turn = async (userInput, signal, attachments = null, onToken = null) => {
    const planActive = isPlanMode();
    const text = planActive ? PLAN_PREFIX + userInput : userInput;
    const userMessage = buildUserMessage(text, attachments);
    state.messages.push(userMessage);

    // In plan mode, after the model emits its first no-tool-calls message
    // (the draft plan), we inject PLAN_CRITIQUE_PROMPT once to force a
    // pressure-test + revision pass. Local flag — per-turn, not persisted.
    let planCritiqueDone = false;

    try {
      while (true) {
        if (signal?.aborted) throw new Interrupted();

        const { message } = await streamCompletion(
          { model: state.model, messages: state.messages, toolSchemas, usage: state.usage, onToken },
          signal
        );
        state.messages.push(message);

        if (!message.tool_calls?.length) {
          // Plan-mode critique pass: inject a self-critique user message
          // and let the model revise. Guarded by planActive (not isPlanMode())
          // so toggling /plan off mid-turn doesn't strand a critique.
          if (planActive && !planCritiqueDone) {
            planCritiqueDone = true;
            ui.info("plan mode: pressure-testing the draft, then finalizing...");
            state.messages.push({ role: "user", content: PLAN_CRITIQUE_PROMPT });
            continue;
          }

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
    // Keep the current turn intact (last regular user message onward) so we
    // never orphan a tool-result from its assistant.tool_calls pairing.
    const tailStart = findSafeTailStart(state.messages);
    if (tailStart < 0) return "Nothing to compact yet.";
    const tail = state.messages.slice(tailStart);
    const middle = state.messages.slice(1, tailStart);
    if (middle.length < 4) return "Nothing to compact yet.";

    // Thread file-ops from the messages we're about to summarize into the
    // cumulative set so the trailer reflects everything since session start,
    // not just this compaction round.
    extractFileOpsInto(middle, state.compactionFileOps);

    const instruction = state.lastCompactionSummary
      ? UPDATE_SUMMARY_INSTRUCTION(state.lastCompactionSummary)
      : FRESH_SUMMARY_INSTRUCTION;

    const summaryPrompt = [
      {
        role: "system",
        content: "You are a conversation summarization assistant. Output only the structured summary the user's instruction asks for. Never continue the conversation.",
      },
      {
        role: "user",
        content: `${instruction}\n\n${serializeForSummary(middle)}`,
      },
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

    summary = summary.trim();
    state.lastCompactionSummary = summary;

    const fileOpsBlock = renderFileOps(state.compactionFileOps);
    const fullSummary = fileOpsBlock
      ? `${summary}\n\n${fileOpsBlock}`
      : summary;

    state.messages = [
      system,
      { role: "user", content: `[Summary of earlier conversation]\n${fullSummary}` },
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
