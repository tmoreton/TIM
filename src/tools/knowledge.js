// Knowledge base tools - consolidated set

import {
  listDomains,
  listKnowledge,
  searchKnowledge,
  readKnowledge,
  readKnowledgeRefs,
  writeKnowledge,
  appendKnowledge,
} from "../knowledge.js";

// 1. LIST - domains or files (with optional filtering)
export const listKnowledgeSchema = {
  type: "function",
  function: {
    name: "list_knowledge",
    description: "List knowledge domains, or files within a domain. Use without 'domain' to see all domains. Use with 'domain' to see files. Add 'query', 'tags', or 'provides' to filter.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Optional: specific domain to list files from" },
        query: { type: "string", description: "Optional: search in names/descriptions" },
        tags: { type: "array", items: { type: "string" }, description: "Optional: filter by tags" },
        provides: { type: "array", items: { type: "string" }, description: "Optional: filter by what files provide (e.g., 'research', 'metrics')" },
      },
    },
  },
};

// 2. READ - single or multiple files
export const readKnowledgeSchema = {
  type: "function",
  function: {
    name: "read_knowledge",
    description: "Read knowledge file(s). Pass 'ref' (domain/name) for single file, or 'refs' array for multiple. Use for cross-domain research.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Single file reference: 'domain/name'" },
        refs: { type: "array", items: { type: "string" }, description: "Multiple refs: ['domain1/name1', 'domain2/name2']" },
      },
    },
  },
};

// 3. WRITE - create or overwrite
export const writeKnowledgeSchema = {
  type: "function",
  function: {
    name: "write_knowledge",
    description: "Create or overwrite a knowledge file. Use for structured channel info, test logs, or any persistent data agents need.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Knowledge domain (category)" },
        name: { type: "string", description: "File name (no .md extension)" },
        body: { type: "string", description: "Markdown content" },
        description: { type: "string", description: "Brief description" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for organization" },
        provides: { type: "array", items: { type: "string" }, description: "What this file provides (e.g., 'voice', 'metrics', 'trends')" },
        autoLoad: { type: "array", items: { type: "string" }, description: "Agent names that should auto-load this file" },
      },
      required: ["domain", "name", "body"],
    },
  },
};

// 4. APPEND - add to existing (for logging results)
export const appendKnowledgeSchema = {
  type: "function",
  function: {
    name: "append_knowledge",
    description: "Append a section to an existing knowledge file. Use for logging test results, new insights, or timestamps updates. Auto-creates file if needed.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "File reference: 'domain/name'" },
        section: { type: "string", description: "Section heading (e.g., 'AB Test Results Apr 16')" },
        content: { type: "string", description: "Markdown content to append" },
      },
      required: ["ref", "section", "content"],
    },
  },
};

// Run functions
export async function listKnowledgeRun({ domain, query, tags = [], provides = [] }) {
  // List domains if no domain specified
  if (!domain) {
    const domains = listDomains();
    if (!domains.length) return "(no knowledge domains yet — create one with write_knowledge)";
    return domains.map(d => `- ${d}`).join("\n");
  }
  
  // Search across domains if query/tags/provides specified without specific domain
  if (query || tags.length || provides.length) {
    const results = searchKnowledge(query || "", { tags, provides, domains: domain ? [domain] : undefined });
    if (!results.length) return `(no knowledge files matching criteria)`;
    return results.map(f => {
      const prov = f.provides?.length ? ` [${f.provides.join(",")}]` : "";
      const t = f.tags?.length ? ` {${f.tags.join(", ")}}` : "";
      const desc = f.description ? ` — ${f.description}` : "";
      return `- **${f.fullName}**${prov}${t}${desc}`;
    }).join("\n");
  }
  
  // List files in domain
  const files = listKnowledge(domain);
  if (!files.length) return `(no knowledge files in '${domain}' domain)`;
  
  return files.map(f => {
    const load = f.load !== "manual" && !Array.isArray(f.load) ? ` [load: ${f.load}]` : 
                  Array.isArray(f.load) ? ` [load: ${f.load.join(",")}]` : "";
    const prov = f.provides?.length ? ` [${f.provides.join(",")}]` : "";
    const t = f.tags?.length ? ` {${f.tags.join(", ")}}` : "";
    const desc = f.description ? ` — ${f.description}` : "";
    return `- **${f.fullName}**${load}${prov}${t}${desc}`;
  }).join("\n");
}

export async function readKnowledgeRun({ ref, refs }) {
  // Handle single ref
  if (ref && !refs) {
    const [domain, ...nameParts] = ref.split("/");
    const name = nameParts.join("/");
    const data = readKnowledge(domain, name);
    if (!data) return `ERROR: knowledge file '${ref}' not found`;
    
    const meta = [];
    if (data.meta.description) meta.push(`Description: ${data.meta.description}`);
    if (data.meta.tags?.length) meta.push(`Tags: ${data.meta.tags.join(", ")}`);
    if (data.meta.provides?.length) meta.push(`Provides: ${data.meta.provides.join(", ")}`);
    
    return meta.length ? meta.join("\n") + `\n\n---\n\n${data.body}` : data.body;
  }
  
  // Handle multiple refs
  if (refs && refs.length) {
    const items = readKnowledgeRefs(refs);
    if (!items.length) return "ERROR: no knowledge files found";
    
    return items.map(data => {
      const header = `\n=== ${data.fullName} ===\n`;
      return header + data.body;
    }).join("\n\n");
  }
  
  return "ERROR: provide either 'ref' or 'refs'";
}

export async function writeKnowledgeRun({ domain, name, body, description = "", tags = [], provides = [], autoLoad = [] }) {
  const filepath = writeKnowledge(domain, name, { 
    description, 
    tags, 
    load: autoLoad.length ? autoLoad : "manual",
    provides, 
    body 
  });
  return `Created knowledge file: ${filepath}`;
}

export async function appendKnowledgeRun({ ref, section, content }) {
  const [domain, ...nameParts] = ref.split("/");
  const name = nameParts.join("/");
  const filepath = appendKnowledge(domain, name, section, content);
  return `Appended to ${ref}`;
}
