// LRU cache for deterministic tools (read_file, list_files, grep, glob).
// Entries track the abs paths they depend on so write_file / edit_file / bash
// can surgically invalidate stale results instead of blanket-clearing.

import path from "node:path";

export class ToolCache {
  constructor(maxSize = 100) {
    this.cache = new Map(); // key -> { result, deps: Set<absPath> }
    this.maxSize = maxSize;
  }

  static key(toolName, args) {
    // Sort args keys so {a:1,b:2} and {b:2,a:1} hit the same entry.
    const sorted = {};
    for (const k of Object.keys(args || {}).sort()) sorted[k] = args[k];
    return `${toolName}:${JSON.stringify(sorted)}`;
  }

  isCacheable(toolName) {
    return ["read_file", "list_files", "grep", "glob"].includes(toolName);
  }

  get(toolName, args) {
    if (!this.isCacheable(toolName)) return undefined;
    const entry = this.cache.get(ToolCache.key(toolName, args));
    return entry?.result;
  }

  // deps: array of absolute paths that, if modified, should invalidate this
  // entry. For read_file: the file itself. For list_files / grep / glob: the
  // root dir (any descendant change invalidates).
  set(toolName, args, result, deps = []) {
    if (!this.isCacheable(toolName)) return;
    if (String(result).startsWith("ERROR:")) return;

    const key = ToolCache.key(toolName, args);
    this.cache.set(key, { result, deps: new Set(deps) });

    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  // Drop every entry whose dep path is equal to, or an ancestor of, absPath.
  // Covers read_file (exact), list_files (parent), grep/glob (ancestor).
  invalidatePath(absPath) {
    if (!absPath) return;
    const target = path.resolve(absPath);
    for (const [key, entry] of this.cache) {
      for (const dep of entry.deps) {
        if (dep === target || target.startsWith(dep + path.sep)) {
          this.cache.delete(key);
          break;
        }
      }
    }
  }

  clear() {
    this.cache.clear();
  }
}
