// Skills are reusable procedural recipes at $TIM_DIR/skills/*.md. Unlike
// agents (identities) or workflows (bound task specs), a skill is a
// markdown how-to that ANY agent can consult when a task matches its
// description. Loading is lazy: the system prompt only advertises each
// skill's name + description; the model calls read_skill(name) to pull
// the full body when it decides the skill is relevant.
//
// File shape matches agents/workflows — same frontmatter+body pattern,
// same validateMeta/renderFrontmatter machinery — so hand-editors and
// the scaffolder keep working without special cases.

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter, validateMeta, renderFrontmatter } from "./paths.js";

export const getSkillsDir = () => timPath("skills");

export const SKILL_SCHEMA = {
  name:        { type: "string", required: true,  doc: "Skill identifier (kebab-case)" },
  description: { type: "string", required: true,  doc: "One-line description — MUST be action-oriented. This is what the model sees to decide whether to consult the skill." },
};

export function ensureSkillsDir() {
  fs.mkdirSync(getSkillsDir(), { recursive: true });
}

export function skillExists(name) {
  return fs.existsSync(path.join(getSkillsDir(), `${name}.md`));
}

export function skillPath(name) {
  return path.join(getSkillsDir(), `${name}.md`);
}

export function writeSkillProfile(name, { description = "", body = "" }) {
  ensureSkillsDir();
  const meta = { name, description };
  const filepath = skillPath(name);
  fs.writeFileSync(filepath, renderFrontmatter(meta, SKILL_SCHEMA, body));
  return filepath;
}

export function deleteSkillProfile(name) {
  const p = skillPath(name);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

const readDir = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
};

export function loadSkills() {
  const skills = {};
  const dir = getSkillsDir();
  for (const file of readDir(dir)) {
    const full = path.join(dir, file);
    const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
    const name = meta.name || path.basename(file, ".md");
    const { errors, fatal } = validateMeta({ ...meta, name }, SKILL_SCHEMA);
    for (const e of errors) console.warn(`[skills] ${file}: ${e}`);
    if (fatal) continue;
    skills[name] = {
      name,
      description: meta.description || "",
      body,
      source: full,
    };
  }
  return skills;
}

// Load a single skill by name, returning the full body. Used by the
// read_skill tool. Returns { skill, error } — error is a user-facing
// string with did-you-mean hints when the name is unknown.
export function readSkill(name) {
  const skills = loadSkills();
  if (skills[name]) return { skill: skills[name] };

  const known = Object.keys(skills);
  const suggestion = known
    .map((k) => ({ name: k, d: editDistance(name, k) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d)[0];
  const hint = suggestion ? ` Did you mean "${suggestion.name}"?` : "";
  const list = known.length ? known.join(", ") : "(none)";
  return { error: `unknown skill "${name}".${hint} Available: ${list}` };
}

// Small local Levenshtein — keep skills.js self-contained so paths.js
// doesn't need to export its internal helper.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
