// Minimal cron matcher. Supports 5-field expressions: minute hour dayOfMonth month dayOfWeek.
// Each field accepts: *, N, N-M, N,M, */N, or combinations like 1,5-10/2.
// Not a full cron — no named months, no '?', no 'L'/'W'. Good enough for agent triggers.

const FIELD_RANGES = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week (0 = Sunday)
];

// Parse a single field like "*/5" or "1,5-10" into a Set of allowed values.
// Returns null to mean "any value" (faster than building a full Set of 0-59).
function parseField(expr, [min, max]) {
  if (expr === "*") return null;
  const out = new Set();

  for (const part of expr.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;

    let lo, hi;
    if (range === "*") {
      [lo, hi] = [min, max];
    } else if (range.includes("-")) {
      [lo, hi] = range.split("-").map((n) => parseInt(n, 10));
    } else {
      lo = parseInt(range, 10);
      hi = stepStr ? max : lo;
    }

    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max) {
      throw new Error(`cron field "${expr}" out of range [${min},${max}]`);
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

export function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron "${expr}" must have 5 fields`);
  return fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
}

export function matches(cronOrParsed, date = new Date()) {
  const parsed = typeof cronOrParsed === "string" ? parseCron(cronOrParsed) : cronOrParsed;
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return parsed.every((set, i) => set === null || set.has(values[i]));
}

// Helper: are two dates within the same minute? Used to dedupe fires within one tick.
export const sameMinute = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate() &&
  a.getHours() === b.getHours() &&
  a.getMinutes() === b.getMinutes();
