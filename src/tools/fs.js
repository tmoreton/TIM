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
import { snapshotFile } from "../history.js";

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
    const entries = fs.readdirSync(abs, { withFileTypes: true });
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
  const truncated = lines.length >= MAX_LIST_ENTRIES ? `\n...[truncated at ${MAX_LIST_ENTRIES} entries]` : "";
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
      `\n...[truncated ${content.length - MAX_FILE_CHARS} chars]`;
  } else {
    body = content;
  }

  return { content: body, cacheDeps: [abs] };
}

// edit_file
export const editSchema = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Replace old_string with new_string in a file. old_string must appear exactly once unless replace_all is true. File must have been read first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

export async function editRun({ path: p, old_string, new_string, replace_all = false }, ctx = {}) {
  const abs = resolveAny(p);
  const blocked = selfEditGuard(abs);
  if (blocked) return blocked;
  const readSnap = readFiles.get(abs);
  if (!readSnap)
    return `ERROR: read_file ${p} before editing it.`;
  const current = statOrNull(abs);
  if (current && (current.mtimeMs !== readSnap.mtimeMs || current.size !== readSnap.size))
    return `ERROR: ${p} was modified since you read it (mtime or size changed). read_file it again before editing.`;
  const original = fs.readFileSync(abs, "utf8");

  let updated;
  if (replace_all) {
    if (!original.includes(old_string))
      return `ERROR: old_string not found in ${p}`;
    updated = original.split(old_string).join(new_string);
  } else {
    const first = original.indexOf(old_string);
    if (first === -1) return `ERROR: old_string not found in ${p}`;
    const second = original.indexOf(old_string, first + old_string.length);
    if (second !== -1)
      return `ERROR: old_string matches ${
        original.split(old_string).length - 1
      } times in ${p}. Provide a longer unique snippet or set replace_all=true.`;
    updated = original.slice(0, first) + new_string + original.slice(first + old_string.length);
  }

  const ok = await confirm("edit_file", { path: p }, `edit ${p}`);
  if (!ok) return "User denied the edit.";

  snapshotFile(abs);
  fs.writeFileSync(abs, updated);
  markRead(abs); // refresh mtime snapshot so subsequent edits don't false-positive
  ctx.toolCache?.invalidatePath(abs);
  editDiff(old_string, new_string);
  return `Edited ${p}`;
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
  const exists = fs.existsSync(abs);
  const ok = await confirm(
    "write_file",
    { path: p },
    `${exists ? "overwrite" : "create"} ${p} (${content.length} bytes)`,
  );
  if (!ok) return "User denied the write.";
  snapshotFile(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  markRead(abs);
  ctx.toolCache?.invalidatePath(abs);
  writeDiff(content);
  return `Wrote ${content.length} bytes to ${p}`;
}
