// read_skill + create_skill.
//
// read_skill loads a skill body from $TIM_DIR/skills/<name>.md. The body
// is canonical markdown the model can follow step-by-step. Descriptions
// (what the model sees in the system prompt) are intentionally short so
// the model has to pull the full body to actually use the skill — this
// keeps the system prompt cheap even with many skills installed.
//
// create_skill is the in-chat scaffolder (parallel to create_agent /
// create_workflow). Useful when the user says "save this as a skill."

import { readSkill, skillExists, writeSkillProfile } from "../skills.js";

export const readSkillSchema = {
  type: "function",
  function: {
    name: "read_skill",
    description:
      "Load the full body of a skill from $TIM_DIR/skills/<name>.md. Skills are reusable procedural recipes (how to deploy X, how to format Y, known failure modes for Z). The system prompt advertises available skills with just name+description; call read_skill when a user's task matches a skill's description to pull the canonical steps before attempting it yourself.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name (kebab-case, as shown in the Available skills block).",
        },
      },
      required: ["name"],
    },
  },
};

export async function readSkillRun({ name }) {
  const { skill, error } = readSkill(name);
  if (error) return `ERROR: ${error}`;
  // Frame the body so the model is clear this is a recipe to follow, not
  // conversational content. Including the description keeps intent local
  // even when the skill body is long.
  return `# Skill: ${skill.name}\n${skill.description}\n\n---\n\n${skill.body}`;
}

export const createSkillSchema = {
  type: "function",
  function: {
    name: "create_skill",
    description:
      "Create a new skill at $TIM_DIR/skills/<name>.md. Skills are reusable procedural recipes — 'how to X' documentation the model consults when a task matches. Good skills have an action-oriented description (e.g. 'Deploy a Next.js app to Vercel — env setup, build verification, rollback') and a body with clear steps, gotchas, and verification. " +
      "Before calling this, list_files on $TIM_DIR/skills to avoid duplicates. Fails if the skill already exists — the user must delete it first.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill identifier (kebab-case, e.g. 'deploy-nextjs-vercel').",
        },
        description: {
          type: "string",
          description: "One-line action-oriented description — this is what the model sees in the system prompt to decide relevance. Be specific: 'Deploy a Next.js app to Vercel — env setup, build verification, rollback', not 'About Vercel'.",
        },
        body: {
          type: "string",
          description: "The skill body — canonical markdown procedure. Typical structure: When to use / Steps / Verification / Gotchas. No frontmatter — that's managed for you.",
        },
      },
      required: ["name", "description", "body"],
    },
  },
};

export async function createSkillRun({ name, description, body }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return `ERROR: skill name must be kebab-case (lowercase, digits, hyphens), got "${name}".`;
  }
  if (skillExists(name)) {
    return `ERROR: skill "${name}" already exists. Delete it first with \`tim skill delete ${name}\` if you want to recreate it.`;
  }
  const filepath = writeSkillProfile(name, { description, body });
  return `Created skill "${name}" at ${filepath}. Any agent can now consult it via read_skill("${name}").`;
}

export const tools = {
  read_skill: {
    schema: readSkillSchema, run: readSkillRun,
    promptSnippet: "read_skill: load the full body of a skill (procedural recipe)",
    promptGuidelines: [
      "When a user's task matches the description of an available skill, call read_skill FIRST to get the canonical procedure before attempting the task. Skills encode tested steps, gotchas, and verification — don't reinvent them.",
    ],
  },
  create_skill: {
    schema: createSkillSchema, run: createSkillRun,
    promptSnippet: "create_skill: scaffold a new reusable procedural recipe in $TIM_DIR/skills/",
  },
};
