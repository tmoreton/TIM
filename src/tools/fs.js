// File system tools: list, read, edit, write.
// All paths are resolved relative to process.cwd() and must stay within it.
// edit_file requires the file to be read first (tracked in readFiles Set).
// All destructive operations (edit, write) require user confirmation.

import fs from "node:fs";
import path from "node:path";
import { confirm } from "../permissions.js";
import { editDiff, writeDiff } from "../ui.js";

const resolveSafe = (p) => {
  const cwd = process.cwd();
  const abs = path.resolve(cwd, p);
  if (abs !== cwd && !abs.startsWith(cwd + path.sep))
    throw new Error(`Path outside workspace: ${p}`);
  return abs;
};

const readFiles = new Set();

export const markRead = (absPath) => readFiles.add(absPath);

export function rehydrateReadsFromMessages(messages) {
  readFiles.clear();
  for (const m of messages || []) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name;
      if (name !== "read_file" && name !== "write_file") continue;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        if (args.path) readFiles.add(path.resolve(process.cwd(), args.path));
      } catch {}
    }
  }
}

export const listFiles = {
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
  run: async ({ path: p = "." }) => {
    const abs = resolveSafe(p);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n");
  },
};

const MAX_FILE_CHARS = 50_000; // ~12k tokens, reasonable for most files
const MAX_FILE_LINES = 500;

export const readFile = {
  schema: {
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
  },
  run: async ({ path: p, offset = 0, limit }) => {
    const abs = resolveSafe(p);
    const content = fs.readFileSync(abs, "utf8");
    readFiles.add(abs);

    const lines = content.split("\n");
    const totalLines = lines.length;
    const effectiveLimit = Math.min(limit || MAX_FILE_LINES, MAX_FILE_LINES);

    // Apply offset/limit
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
      return prefix + slice + suffix;
    }

    // Simple truncation for huge single-line or massive files
    if (content.length > MAX_FILE_CHARS) {
      return (
        content.slice(0, MAX_FILE_CHARS) +
        `\n...[truncated ${content.length - MAX_FILE_CHARS} chars]`
      );
    }

    return content;
  },
};

export const editFile = {
  schema: {
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
  },
  run: async ({ path: p, old_string, new_string, replace_all = false }) => {
    const abs = resolveSafe(p);
    if (!readFiles.has(abs))
      return `ERROR: read_file ${p} before editing it.`;
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

    fs.writeFileSync(abs, updated);
    editDiff(old_string, new_string);
    return `Edited ${p}`;
  },
};

export const writeFile = {
  schema: {
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
  },
  run: async ({ path: p, content }) => {
    const abs = resolveSafe(p);
    const exists = fs.existsSync(abs);
    const ok = await confirm(
      "write_file",
      { path: p },
      `${exists ? "overwrite" : "create"} ${p} (${content.length} bytes)`,
    );
    if (!ok) return "User denied the write.";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    readFiles.add(abs);
    writeDiff(content);
    return `Wrote ${content.length} bytes to ${p}`;
  },
};
