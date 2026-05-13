// Per-file promise chain so concurrent edit_file/write_file calls targeting
// the same path serialize, while different files still run in parallel.
// Key is the resolved realpath when possible so `foo.txt` and `./foo.txt`
// share a queue; falls back to the resolved absolute path if the file
// doesn't exist yet (new write).

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const queues = new Map();

const keyFor = (filePath) => {
  const abs = resolve(filePath);
  try {
    return realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
  } catch {
    return abs;
  }
};

export function runExclusive(filePath, fn) {
  const key = keyFor(filePath);
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive on failure but drop the reference when it settles
  // so the map doesn't grow unbounded.
  const tracked = next.catch(() => {});
  queues.set(key, tracked);
  tracked.finally(() => {
    if (queues.get(key) === tracked) queues.delete(key);
  });
  return next;
}
