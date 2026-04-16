// Built-in knowledge base system for tim agents
// Organizes knowledge by domain (youtube, projects, etc.)
// Files stored in $TIM_DIR/knowledge/<domain>/*.md

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter } from "./paths.js";

const knowledgeDir = () => timPath("knowledge");

const ensureDir = (subPath = "") => {
  const dir = path.join(knowledgeDir(), subPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// List all knowledge domains
export function listDomains() {
  const dir = knowledgeDir();
  try {
    return fs.readdirSync(dir).filter(f => {
      const stat = fs.statSync(path.join(dir, f));
      return stat.isDirectory();
    });
  } catch {
    return [];
  }
}

// List all knowledge files in a domain
export function listKnowledge(domain, options = {}) {
  const dir = path.join(knowledgeDir(), domain);
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
    return files.map(f => {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      const { meta } = parseFrontmatter(content);
      return {
        name: f.replace(/\.md$/, ""),
        fullName: `${domain}/${f.replace(/\.md$/, "")}`,
        domain,
        description: meta.description || "",
        tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
        updated: meta.updated || null,
        load: meta.load || "manual", // "auto", "referenced", "manual", or ["specific", "files"]
        provides: meta.provides || [], // What this file provides ("voice", "metrics", "history")
      };
    });
  } catch {
    return [];
  }
}

// Search across all domains
export function searchKnowledge(query, options = {}) {
  const { tags = [], provides = [], domains = [] } = options;
  const allFiles = [];
  
  const domainsToSearch = domains.length ? domains : listDomains();
  
  for (const domain of domainsToSearch) {
    const files = listKnowledge(domain);
    for (const file of files) {
      // Match by tags
      if (tags.length && !tags.some(t => file.tags.includes(t))) continue;
      // Match by provides
      if (provides.length && !provides.some(p => file.provides?.includes(p))) continue;
      // Match by name/description
      if (query && !file.name.toLowerCase().includes(query.toLowerCase()) && 
          !file.description.toLowerCase().includes(query.toLowerCase())) continue;
      
      allFiles.push(file);
    }
  }
  
  return allFiles;
}

// Read a specific knowledge file
export function readKnowledge(domain, name) {
  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const filepath = path.join(knowledgeDir(), domain, filename);
  try {
    const content = fs.readFileSync(filepath, "utf8");
    const { meta, body } = parseFrontmatter(content);
    return { 
      meta, 
      body, 
      path: filepath,
      name: filename.replace(/\.md$/, ""),
      domain,
      fullName: `${domain}/${filename.replace(/\.md$/, "")}`
    };
  } catch (e) {
    return null;
  }
}

// Read multiple knowledge files by reference
export function readKnowledgeRefs(refs) {
  // refs can be: "domain/name", {domain, name}, or ["domain1/name1", "domain2/name2"]
  const items = [];
  const list = Array.isArray(refs) ? refs : refs ? [refs] : [];
  
  for (const ref of list) {
    if (typeof ref === "string") {
      const [domain, ...nameParts] = ref.split("/");
      const name = nameParts.join("/");
      const data = readKnowledge(domain, name);
      if (data) items.push(data);
    } else if (ref.domain && ref.name) {
      const data = readKnowledge(ref.domain, ref.name);
      if (data) items.push(data);
    }
  }
  
  return items;
}

// Write/update a knowledge file
export function writeKnowledge(domain, name, { 
  description = "", 
  tags = [], 
  load = "manual",
  provides = [],
  body = "" 
}) {
  const dir = ensureDir(domain);
  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const filepath = path.join(dir, filename);
  const timestamp = new Date().toISOString().split("T")[0];
  
  const frontmatter = [`---`, `updated: ${timestamp}`, `description: ${description}`];
  
  if (tags.length) {
    frontmatter.push(`tags: [${tags.join(", ")}]`);
  }
  if (load !== "manual") {
    if (Array.isArray(load)) {
      frontmatter.push(`load: [${load.map(l => `"${l}"`).join(", ")}]`);
    } else {
      frontmatter.push(`load: ${load}`);
    }
  }
  if (provides.length) {
    frontmatter.push(`provides: [${provides.join(", ")}]`);
  }
  
  frontmatter.push(`---`, "");
  const content = frontmatter.join("\n") + body;
  fs.writeFileSync(filepath, content);
  return filepath;
}

// Append to a knowledge file (for logging results/insights)
export function appendKnowledge(domain, name, section, content) {
  const dir = ensureDir(domain);
  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const filepath = path.join(dir, filename);
  const timestamp = new Date().toISOString().split("T")[0];
  const entry = `\n## ${section} (${timestamp})\n\n${content}\n`;
  
  if (fs.existsSync(filepath)) {
    fs.appendFileSync(filepath, entry);
  } else {
    const header = `---\nupdated: ${timestamp}\ndescription: Auto-created knowledge file\n---\n\n# ${name.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())}\n`;
    fs.writeFileSync(filepath, header + entry);
  }
  return filepath;
}

// Get knowledge to auto-load for an agent's primary domain + explicit refs
export function getInitialKnowledge(primaryDomain = null, explicitRefs = []) {
  const items = [];
  const seen = new Set();
  
  // 1. Auto-load from primary domain
  if (primaryDomain) {
    const autoFiles = listKnowledge(primaryDomain).filter(k => 
      k.load === "auto" || 
      (Array.isArray(k.load) && k.load.includes("auto"))
    );
    for (const file of autoFiles) {
      const data = readKnowledge(primaryDomain, file.name);
      if (data && !seen.has(data.fullName)) {
        items.push(data);
        seen.add(data.fullName);
      }
    }
  }
  
  // 2. Explicit refs (can be cross-domain)
  const explicit = readKnowledgeRefs(explicitRefs);
  for (const data of explicit) {
    if (!seen.has(data.fullName)) {
      items.push(data);
      seen.add(data.fullName);
    }
  }
  
  return items;
}

// Format knowledge for injection into system prompt
export function formatKnowledgeForContext(knowledgeItems) {
  if (!knowledgeItems?.length) return "";
  
  const sections = knowledgeItems.map(k => {
    const source = k.fullName ? `*[${k.fullName}]*\n` : "";
    return `${source}## ${k.name}\n${k.body}`;
  });
  
  return `\n\n---\n\n## Knowledge Base\n\n${sections.join("\n\n---\n\n")}`;
}
