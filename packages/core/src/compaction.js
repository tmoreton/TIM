// Compaction helpers. Extracted from react.js so they're unit-testable
// without wiring a faux LLM.
//
// Design notes:
// - File-op tracking walks assistant messages for read_file / write_file /
//   edit_file tool calls and splits them into read / modified sets. Sets
//   are merged into cumulative state across multiple compactions so the
//   trailer reflects everything since session start.
// - serializeForSummary flattens the conversation into a <conversation>…
//   </conversation> block so the summarizer treats it as content, not as a
//   conversation to continue. Tool results are truncated to 2000 chars.

export function extractFileOpsInto(messages, acc) {
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name;
      if (name !== "read_file" && name !== "write_file" && name !== "edit_file") continue;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { continue; }
      if (typeof args.path !== "string") continue;
      if (name === "read_file") acc.read.add(args.path);
      else acc.modified.add(args.path);
    }
  }
}

export function renderFileOps(ops) {
  const modified = [...ops.modified];
  // A file that was read and then modified is shown under modified only.
  const readOnly = [...ops.read].filter((p) => !ops.modified.has(p));
  const parts = [];
  if (readOnly.length) parts.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
  if (modified.length) parts.push(`<modified-files>\n${modified.join("\n")}\n</modified-files>`);
  return parts.join("\n\n");
}

export function serializeForSummary(messages) {
  const lines = ["<conversation>"];
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string"
        ? m.content
        : (m.content || []).find((c) => c?.type === "text")?.text || "[non-text user message]";
      lines.push(`[User]: ${text}`);
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`[Assistant]: ${m.content}`);
      if (m.tool_calls?.length) {
        const calls = m.tool_calls.map((tc) => {
          let args = tc.function.arguments || "";
          if (args.length > 400) args = args.slice(0, 400) + "…";
          return `${tc.function.name}(${args})`;
        }).join("; ");
        lines.push(`[Assistant tool calls]: ${calls}`);
      }
    } else if (m.role === "tool") {
      let c = typeof m.content === "string" ? m.content : "[non-text tool result]";
      if (c.length > 2000) c = c.slice(0, 2000) + "…[truncated]";
      lines.push(`[Tool result]: ${c}`);
    }
  }
  lines.push("</conversation>");
  return lines.join("\n");
}

export const FRESH_SUMMARY_INSTRUCTION = `Summarize the conversation below into a compact handoff that another agent can resume from. Do NOT continue the conversation or answer any questions in it — ONLY output the summary.

Use this exact structure (omit a section if truly empty):

## Goal
What the user is ultimately trying to accomplish.

## Progress
### Done
- bullet per completed step (with file paths / commands where relevant)
### In Progress
- bullet per started-but-unfinished step
### Blocked
- bullet per blocker (what's needed to unblock)

## Key Decisions
- bullet per decision made and its rationale

## Next Steps
- concrete, ordered list the resumed agent can execute

## Critical Context
- any constraint, preference, or subtlety that would be lost otherwise (user phrasing, stylistic preferences, prior failures worth avoiding)

Be dense. No preamble. No farewell.`;

export const UPDATE_SUMMARY_INSTRUCTION = (previous) => `You are updating an existing handoff summary by folding in new conversation since it was written.

Previous summary:
---
${previous}
---

New conversation follows. Produce an UPDATED summary in the exact same section structure (## Goal / ## Progress {Done,In Progress,Blocked} / ## Key Decisions / ## Next Steps / ## Critical Context). Move completed items from In Progress → Done, add new work, drop anything no longer relevant. Do NOT answer questions in the conversation — ONLY output the updated summary.`;
