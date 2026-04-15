// LRU cache for deterministic tools (read_file, list_files, grep, glob).
// Caches successful results, auto-evicts when max size exceeded.

export class ToolCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  static key(toolName, args) {
    return `${toolName}:${JSON.stringify(args)}`;
  }

  isCacheable(toolName) {
    return ["read_file", "list_files", "grep", "glob"].includes(toolName);
  }

  get(toolName, args) {
    if (!this.isCacheable(toolName)) return undefined;
    return this.cache.get(ToolCache.key(toolName, args));
  }

  set(toolName, args, result) {
    if (!this.isCacheable(toolName)) return;
    if (String(result).startsWith("ERROR:")) return;

    const key = ToolCache.key(toolName, args);
    this.cache.set(key, result);

    // LRU eviction
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  clear() {
    this.cache.clear();
  }
}
