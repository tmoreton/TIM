// Git-backed history for $TIM_DIR. Every turn auto-commits so user
// customizations (agents/, workflows/, tools/, memory/, TIM.md, etc.) can be
// reviewed or reverted with standard git commands. The repo is initialized
// lazily on the first tracked change. High-churn or secret files are excluded
// via a bootstrap .gitignore.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { timDir } from "./paths.js";

const GITIGNORE = [
  ".env",
  ".DS_Store",
  "sessions/",
  "images/",
  "triggers/state.json",
  "",
].join("\n");

const git = (args) =>
  spawnSync("git", args, { cwd: timDir(), stdio: "ignore" });

// Read a config value. Returns "" if unset. Used to avoid shadowing a user's
// global git identity with our local fallback.
const gitConfigGet = (key) => {
  const r = spawnSync("git", ["config", "--get", key], { cwd: timDir(), encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

function ensureRepo() {
  const dir = timDir();
  if (!fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, ".git"))) return true;
  if (git(["--version"]).status !== 0) return false; // git not installed
  if (git(["init", "-q"]).status !== 0) return false;
  // Fallback identity only if the user has nothing global — don't shadow their
  // real git config when they have one.
  if (!gitConfigGet("user.email")) git(["config", "user.email", "tim@localhost"]);
  if (!gitConfigGet("user.name"))  git(["config", "user.name", "tim"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE);
  git(["add", "-A"]);
  git(["commit", "-q", "--allow-empty", "-m", "tim: initialize history"]);
  return true;
}

// Stage every change under $TIM_DIR and commit with `summary`. If nothing
// changed, `git commit` exits nonzero and we silently return false.
export function commit(summary) {
  if (!ensureRepo()) return false;
  git(["add", "-A"]);
  const msg = (summary || "tim: update").slice(0, 200);
  return git(["commit", "-q", "-m", msg]).status === 0;
}
