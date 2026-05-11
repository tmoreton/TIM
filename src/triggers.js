// Triggers are markdown files in $TIM_DIR/triggers/. Each declares a cron
// schedule, a workflow to run (which in turn resolves its agent), and an
// optional task override. Runtime state (last fire time, last status) is
// kept in $TIM_DIR/triggers/state.json.

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter } from "./paths.js";
import { parseCron } from "./cron.js";
import { loadWorkflows, mergeProfile } from "./workflows.js";
import { loadAgents } from "./agents.js";
import { createAgent } from "./react.js";


export const getTriggersDir = () => timPath("triggers");
const statePath = () => path.join(getTriggersDir(), "state.json");

export function ensureTriggersDir() {
  fs.mkdirSync(getTriggersDir(), { recursive: true });
}

export function loadTriggers() {
  const dir = getTriggersDir();
  if (!fs.existsSync(dir)) return [];
  const triggers = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const full = path.join(dir, file);
    const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
    const name = meta.name || path.basename(file, ".md");
    if (!meta.schedule) continue;
    try {
      parseCron(meta.schedule);
    } catch (e) {
      console.warn(`[triggers] skipping "${name}": invalid schedule "${meta.schedule}" — ${e.message}`);
      continue;
    }
    const stripQuotes = (s) => typeof s === "string" ? s.replace(/^["'](.*)["']$/, "$1") : s;
    triggers.push({
      name,
      schedule: stripQuotes(meta.schedule),
      workflow: meta.workflow,
      task: stripQuotes(meta.task) || body.trim(),
      description: stripQuotes(meta.description) || "",
      enabled: meta.enabled !== "false" && meta.enabled !== false,
      precheck: meta.precheck ? stripQuotes(meta.precheck) : null,
      source: full,
    });
  }
  return triggers;
}

export function writeTrigger(name, { schedule, workflow, task = "", description = "", enabled = true }) {
  ensureTriggersDir();
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `schedule: ${schedule}`,
    `workflow: ${workflow}`,
  ];
  if (task) lines.push(`task: ${task}`);
  lines.push(`enabled: ${enabled}`, "---", "");
  const filepath = path.join(getTriggersDir(), `${name}.md`);
  fs.writeFileSync(filepath, lines.join("\n"));
  return filepath;
}

export function deleteTrigger(name) {
  const p = path.join(getTriggersDir(), `${name}.md`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  const state = loadState();
  delete state[name];
  saveState(state);
  return true;
}

export function triggerExists(name) {
  return fs.existsSync(path.join(getTriggersDir(), `${name}.md`));
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state) {
  ensureTriggersDir();
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function getTriggerState(name) {
  return loadState()[name] || null;
}

export function recordRun(name, { startedAt, finishedAt, status, error }) {
  const state = loadState();
  state[name] = {
    ...(state[name] || {}),
    lastRunAt: startedAt,
    lastFinishedAt: finishedAt,
    lastStatus: status,
    lastError: error || null,
  };
  saveState(state);
}

// Resolve and run a trigger by name. Validates the workflow and agent exist,
// merges the profile, and executes the task. Used by CLI, REPL, and scheduler.
export async function runTrigger(name, { log = console.log } = {}) {
  const triggers = loadTriggers();
  const t = triggers.find((x) => x.name === name);
  if (!t) throw new Error(`trigger "${name}" not found`);

  const workflow = loadWorkflows()[t.workflow];
  if (!workflow) throw new Error(`workflow "${t.workflow}" not found`);

  const agent = loadAgents()[workflow.agent];
  if (!agent) throw new Error(`agent "${workflow.agent}" not found`);


  const sub = await createAgent(mergeProfile(agent, workflow));
  const task = t.task || workflow.task || `Run the ${workflow.name} workflow.`;

  log(`→ firing ${name} (${workflow.name} → ${agent.name})`);
  await sub.turn(task);
  log(`✓ ${name} done`);
}
