// File system tools: list, read, edit, write.
// Paths can be anywhere the user's process has access to. Destructive ops
// still prompt for confirmation (unless /yolo) and tim source gets the
// selfEditGuard so cross-project mistakes don't corrupt the install.
// edit_file requires the file to be read first (tracked in readFiles Set).

import fs from "node:fs";
import path from "node:path";
import { confirm } from "../permissions.js";
import { editDiff, writeDiff } from "../ui.js";
import { TIM_SOURCE_ROOT, isInsideTimSource } from "../paths.js";
import { planMultiEdit } from "../edits.js";
import { runExclusive } from "../file-lock.js";

// Returns an error string if `abs` is inside tim's own source but the user
// isn't currently working from within the tim directory. Keeps accidental
// self-edits from other projects from corrupting the install.
const selfEditGuard = (abs) => {
  if (!isInsideTimSource(abs)) return null;
  const cwd = process.cwd();
  const cwdInsideTim =
    cwd === TIM_SOURCE_ROOT || cwd.startsWith(TIM_SOURCE_ROOT + path.sep);
  if (cwdInsideTim) return null;
  return `ERROR: refusing to modify tim source from outside the tim directory (${TIM_SOURCE_ROOT}). cd into it first if you really mean to edit tim itself.`;
};

const resolveAny = (p) => path.resolve(process.cwd(), p);

// Map<absPath, {mtimeMs, size}> — snapshot of file state at read time.
// edit_file compares against this to detect external modifications (bash
// sed, another editor, etc.) so the model doesn't clobber unseen changes.
const readFiles = new Map();

const statOrNull = (abs) => {
  try {
    const s = fs.statSync(abs);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
};

export const markRead = (absPath) => {
  const s = statOrNull(absPath);
  if (s) readFiles.set(absPath, s);
};

export function rehydrateReadsFromMessages(messages) {
  readFiles.clear();
  for (const m of messages || []) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name;
      if (name !== "read_file" && name !== "write_file") continue;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        if (args.path) markRead(path.resolve(process.cwd(), args.path));
      } catch {}
    }
  }
}

const MAX_FILE_CHARS = 200_000;
const MAX_FILE_LINES = 2000;

// list_files
export const schema = {
  type: "function",
  function: {
    name: "list_files",
    description:
      "List files and directories at a relative path. Set recursive:true with depth to tree a directory in one call. Hidden files (dotfiles) excluded by default.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path. Defaults to '.'" },
        recursive: { type: "boolean", description: "Walk subdirectories" },
        depth: { type: "number", description: "Max recursion depth (default 3)" },
        show_hidden: { type: "boolean", description: "Include dotfiles" },
      },
    },
  },
};

const LIST_SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv",
  "venv", "__pycache__", "target", "vendor", "coverage", ".cache",
]);
const MAX_LIST_ENTRIES = 1000;

export async function run({ path: p = ".", recursive = false, depth = 3, show_hidden = false }) {
  const abs = resolveAny(p);

  if (!recursive) {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return { content: `ERROR: ${e.message}` };
    }
    return {
      content: entries
        .filter((e) => show_hidden || !e.name.startsWith("."))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n"),
      cacheDeps: [abs],
    };
  }

  const lines = [];
  const walk = (dir, rel, level) => {
    if (lines.length >= MAX_LIST_ENTRIES) return;
    if (level > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!show_hidden && e.name.startsWith(".")) continue;
      if (e.isDirectory() && LIST_SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      lines.push(e.isDirectory() ? `${childRel}/` : childRel);
      if (lines.length >= MAX_LIST_ENTRIES) return;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel, level + 1);
    }
  };
  walk(abs, "", 1);
  const truncated = lines.length >= MAX_LIST_ENTRIES
    ? `\n...[${MAX_LIST_ENTRIES}-entry cap reached. Narrow with a deeper path, reduce depth, or use glob/grep to find specific files.]`
    : "";
  return { content: lines.join("\n") + truncated, cacheDeps: [abs] };
}

// read_file
export const readSchema = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read the contents of a text file. Large files are truncated with a warning. Use offset to read specific sections.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "number",
          description: "Line offset to start reading from (0-indexed)",
        },
        limit: {
          type: "number",
          description: `Max lines to read (max ${MAX_FILE_LINES})`,
        },
      },
      required: ["path"],
    },
  },
};

export async function readRun({ path: p, offset = 0, limit }) {
  const abs = resolveAny(p);
  const content = fs.readFileSync(abs, "utf8");
  markRead(abs);

  const lines = content.split("\n");
  const totalLines = lines.length;
  const effectiveLimit = Math.min(limit || MAX_FILE_LINES, MAX_FILE_LINES);

  let body;
  if (offset > 0 || totalLines > effectiveLimit) {
    const start = Math.min(offset, totalLines);
    const end = Math.min(start + effectiveLimit, totalLines);
    const slice = lines.slice(start, end).join("\n");
    const prefix =
      start > 0 ? `[lines ${start}-${end} of ${totalLines}]\n` : "";
    const suffix =
      end < totalLines
        ? `\n...[${totalLines - end} more lines, use offset:${end} to continue]`
        : "";
    body = prefix + slice + suffix;
  } else if (content.length > MAX_FILE_CHARS) {
    body = content.slice(0, MAX_FILE_CHARS) +
      `\n...[truncated ${content.length - MAX_FILE_CHARS} chars. File is large — use offset/limit to page, or grep to find specific content.]`;
  } else {
    body = content;
  }

  return { content: body, cacheDeps: [abs] };
}

// edit_file
//
// Two accepted call shapes:
//   { path, old_string, new_string, replace_all? }            — single edit
//   { path, edits: [{old_string, new_string, replace_all?}] } — multi-edit
//
// All edits in a multi-edit call are matched against the ORIGINAL file
// (not after earlier edits are applied) and must not overlap each other.
// This mirrors pi-mono semantics: one tool call can touch several disjoint
// locations without extra round-trips.
//
// On exact-match miss we try a Unicode-normalized fallback (smart quotes,
// unicode dashes, nbsp) to recover from common LLM output drift, but we
// splice the original bytes — the rest of the file is never silently
// renormalized.
export const editSchema = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Edit a file by replacing exact text. Pass either a single edit (old_string/new_string/replace_all) or `edits: [{old_string, new_string, replace_all?}]` for multiple disjoint changes in one call (preferred — saves round-trips). Each old_string is matched against the original file, not after earlier edits. old_string must be unique unless replace_all is set. File must be read_file'd first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Single-edit form: exact text to replace." },
        new_string: { type: "string", description: "Single-edit form: replacement text." },
        replace_all: { type: "boolean", description: "Single-edit form: replace every occurrence." },
        edits: {
          type: "array",
          description: "Multi-edit form: array of {old_string, new_string, replace_all?}. old_strings must not overlap (matched against original).",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path"],
    },
  },
};

export async function editRun(args, ctx = {}) {
  const { path: p } = args;
  if (!p) return "ERROR: path is required";
  const abs = resolveAny(p);
  const blocked = selfEditGuard(abs);
  if (blocked) return blocked;

  // Normalize single-edit into the multi-edit shape.
  let edits = Array.isArray(args.edits) ? args.edits : null;
  if (!edits) {
    if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
      return "ERROR: provide either {old_string, new_string} or edits: [...].";
    }
    edits = [{ old_string: args.old_string, new_string: args.new_string, replace_all: !!args.replace_all }];
  }
  if (edits.length === 0) return "ERROR: edits array is empty";

  return runExclusive(abs, async () => {
    const readSnap = readFiles.get(abs);
    if (!readSnap) return `ERROR: read_file ${p} before editing it.`;
    const current = statOrNull(abs);
    if (current && (current.mtimeMs !== readSnap.mtimeMs || current.size !== readSnap.size))
      return `ERROR: ${p} was modified since you read it (mtime or size changed). read_file it again before editing.`;

    const original = fs.readFileSync(abs, "utf8");
    const planned = planMultiEdit(original, edits);
    if (!planned.ok) return `ERROR: ${planned.error} in ${p}`;

    const label = edits.length === 1
      ? `edit ${p}`
      : `edit ${p} (${edits.length} changes)`;
    const ok = await confirm("edit_file", { path: p }, label);
    if (!ok) return "User denied the edit.";

    fs.writeFileSync(abs, planned.updated);
    markRead(abs); // refresh mtime snapshot so subsequent edits don't false-positive
    ctx.toolCache?.invalidatePath(abs);

    for (const d of planned.appliedDiffs) editDiff(d.old, d.new);
    const fuzzy = planned.appliedDiffs.some((d) => d.fuzzy) ? " (unicode-normalized match)" : "";
    return edits.length === 1
      ? `Edited ${p}${fuzzy}`
      : `Edited ${p}: applied ${edits.length} changes${fuzzy}`;
  });
}

// write_file
export const writeSchema = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Creates parent dirs. Use edit_file for surgical changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
};

export async function writeRun({ path: p, content }, ctx = {}) {
  const abs = resolveAny(p);
  const blocked = selfEditGuard(abs);
  if (blocked) return blocked;
  return runExclusive(abs, async () => {
    const exists = fs.existsSync(abs);
    const ok = await confirm(
      "write_file",
      { path: p },
      `${exists ? "overwrite" : "create"} ${p} (${content.length} bytes)`,
    );
    if (!ok) return "User denied the write.";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    markRead(abs);
    ctx.toolCache?.invalidatePath(abs);
    writeDiff(content);
    return `Wrote ${content.length} bytes to ${p}`;
  });
}

export const tools = {
  list_files: {
    schema, run,
    promptSnippet: "list_files: list or tree a directory",
  },
  read_file: {
    schema: readSchema, run: readRun,
    promptSnippet: "read_file: read a text file (offset/limit for paging)",
  },
  edit_file: {
    schema: editSchema, run: editRun,
    promptSnippet: "edit_file: surgical edits (pass edits:[{old_string,new_string}] for multi-site changes in one call)",
    promptGuidelines: [
      "You MUST read_file before edit_file.",
      "Use edit_file for surgical changes. When changing multiple places in one file, pass `edits: [{old_string, new_string, replace_all?}]` in a single call instead of multiple edit_file calls.",
      "Each old_string in a multi-edit call is matched against the original file (not after earlier edits), and must not overlap any other. Keep old_string small but unique.",
    ],
  },
  write_file: {
    schema: writeSchema, run: writeRun,
    promptSnippet: "write_file: create or fully rewrite a file",
    promptGuidelines: [
      "Use write_file only for new files or complete rewrites; prefer edit_file for surgical changes.",
    ],
  },
};
